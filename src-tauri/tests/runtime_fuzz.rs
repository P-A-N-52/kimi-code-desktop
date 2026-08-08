//! M5 protocol fuzz gate for the runtime-v1 stdio codec and supervisor.
//!
//! Two layers:
//!  1. Deterministic byte-level fuzz of `FrameDecoder` (pure Rust, no node):
//!     seeded xorshift64 mutations over a corpus of valid frames, targeted
//!     error-classification matrices, LF/framing edge cases, size-cap
//!     boundaries (including the real 16 MiB cap), and structural envelope
//!     fuzz (missing/mistyped fields, weird `seq` values, deeply nested
//!     payloads). The gate is: no panic, no out-of-bounds access, no spurious
//!     `Io` errors on an in-memory reader, correct fault classification, and
//!     no decoder desync after a fault frame.
//!  2. Supervisor fail-closed fuzz against the node fixture worker
//!     (`tests/fixtures/runtime-fixture-worker.mjs`): the existing env fault
//!     injections, a mid-handshake SIGKILL, writes after shutdown/fail-closed,
//!     and randomized call sequences. Skipped with a note when `node` is
//!     missing; the fixture is pure node stdlib and touches nothing on disk.
//!
//! Everything is reproducible: every random stream derives from a fixed seed,
//! so a failing iteration reproduces byte-for-byte. No new crates — the PRNG
//! below is ~10 lines.

use app_lib::runtime::codec::{encode_request, FrameDecoder, FrameReadError};
use app_lib::runtime::protocol::{
    EventFrame, FaultCode, HelloParams, OutputFrame, RequestFrame, ResponseFrame, MAX_FRAME_BYTES,
};
use app_lib::runtime::supervisor::{
    HandshakeConfig, RuntimeError, RuntimeSupervisor, ShutdownConfig, SpawnConfig,
    SupervisorOptions, SupervisorState,
};
use serde_json::{json, Value};
use std::io::BufReader;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Fixed-seed xorshift64 PRNG (deterministic across runs and platforms).
struct XorShift64(u64);

impl XorShift64 {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// Uniform in `0..bound` (caller must pass a positive bound).
    fn below(&mut self, bound: usize) -> usize {
        assert!(bound > 0, "PRNG bound must be positive");
        (self.next_u64() % bound as u64) as usize
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.next_u64() as u8).collect()
    }
}

/// Which envelope family a decoded frame belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameKind {
    OkResponse,
    ErrResponse,
    SessionEvent,
    RuntimeEvent,
}

fn kind_of(frame: &OutputFrame) -> FrameKind {
    match frame {
        OutputFrame::Response(ResponseFrame::Ok { .. }) => FrameKind::OkResponse,
        OutputFrame::Response(ResponseFrame::Err { .. }) => FrameKind::ErrResponse,
        OutputFrame::Event(EventFrame::Session { .. }) => FrameKind::SessionEvent,
        OutputFrame::Event(EventFrame::Runtime { .. }) => FrameKind::RuntimeEvent,
    }
}

/// Corpus of known-good frames (each with its expected family).
fn corpus() -> Vec<(Vec<u8>, FrameKind)> {
    vec![
        (
            br#"{"protocol":"runtime-v1","type":"response","id":"req-1","ok":true,"result":{"a":1}}"#
                .to_vec(),
            FrameKind::OkResponse,
        ),
        (
            br#"{"protocol":"runtime-v1","type":"response","id":"req-9","ok":false,"error":{"code":"method_not_found","message":"nope","retryable":false}}"#
                .to_vec(),
            FrameKind::ErrResponse,
        ),
        (
            br#"{"protocol":"runtime-v1","type":"event","sessionId":"s-1","seq":3,"event":"content.delta","payload":{"text":"hi"}}"#
                .to_vec(),
            FrameKind::SessionEvent,
        ),
        (
            br#"{"protocol":"runtime-v1","type":"event","event":"runtime.ready","payload":{}}"#
                .to_vec(),
            FrameKind::RuntimeEvent,
        ),
        // The `\n` here is an escaped newline inside a JSON string (two
        // characters, backslash + n) — a legal frame, not a frame boundary.
        (
            br#"{"protocol":"runtime-v1","type":"event","event":"runtime.warning","payload":{"msg":"line1\nline2"}}"#
                .to_vec(),
            FrameKind::RuntimeEvent,
        ),
    ]
}

/// A valid `runtime.warning` event whose payload message is `pad` bytes of
/// `x` — the whole envelope is exactly `base_len + pad` bytes.
fn warning_frame_with_pad(pad: usize) -> Vec<u8> {
    format!(
        r#"{{"protocol":"runtime-v1","type":"event","event":"runtime.warning","payload":{{"message":"{}"}}}}"#,
        "x".repeat(pad)
    )
    .into_bytes()
}

/// A valid `runtime.warning` event of exactly `target` bytes.
fn warning_frame_exactly(target: usize) -> Vec<u8> {
    let empty = warning_frame_with_pad(0).len();
    assert!(
        target >= empty,
        "target {target} below minimum frame size {empty}"
    );
    warning_frame_with_pad(target - empty)
}

/// Assert an in-memory `read_frame` never reports an I/O error (slices cannot
/// fail) and the fault, when present, is a protocol fault.
fn assert_in_memory_outcome(result: &Result<Option<OutputFrame>, FrameReadError>) {
    match result {
        Ok(_) | Err(FrameReadError::Fault(_)) => {}
        Err(FrameReadError::Io(err)) => panic!("unexpected Io error on in-memory reader: {err}"),
    }
}

// ===========================================================================
// Layer 1: codec deterministic fuzz (pure Rust, always runs).
// ===========================================================================

/// A noise frame (any classification) followed by a known-good frame must
/// still yield the good frame: a fault must never desync the decoder.
#[test]
fn codec_fuzz_noise_frame_then_valid_frame_recovers() {
    let mut rng = XorShift64::new(0x5EED_2026);
    let frames = corpus();
    for iteration in 0..512 {
        let (good_bytes, expected) = rng.pick(&frames).clone();
        let noise_len = rng.below(128);
        let mut noise: Vec<u8> = rng.bytes(noise_len);
        // Keep the boundary unambiguous: noise must not contain an LF.
        noise.retain(|byte| *byte != b'\n');
        let mut stream = noise;
        stream.push(b'\n');
        stream.extend_from_slice(&good_bytes);
        // The corpus frames carry no trailing LF; terminate the good frame.
        stream.push(b'\n');
        let mut reader = BufReader::new(&stream[..]);
        let decoder = FrameDecoder::default();

        let first = decoder.read_frame(&mut reader);
        assert_in_memory_outcome(&first);
        assert!(
            matches!(first, Err(FrameReadError::Fault(_))),
            "iteration {iteration}: noise must fault, got {first:?}"
        );

        let second = decoder.read_frame(&mut reader);
        match second {
            Ok(Some(frame)) => assert_eq!(
                kind_of(&frame),
                expected,
                "iteration {iteration}: good frame misclassified after a fault frame"
            ),
            other => panic!("iteration {iteration}: expected the good frame, got {other:?}"),
        }
        assert!(
            decoder.read_frame(&mut reader).unwrap().is_none(),
            "iteration {iteration}: trailing bytes after the good frame"
        );
    }
}

/// Random byte-level mutations (flips, inserts, deletes, truncations) over
/// the corpus: no panic, no I/O error, and every outcome is either a decoded
/// frame or a classified protocol fault.
#[test]
fn codec_fuzz_byte_mutations_never_panic_or_io() {
    let mut rng = XorShift64::new(0xBAD5EED);
    let frames = corpus();
    let mut observed: Vec<FaultCode> = Vec::new();
    for iteration in 0..1024 {
        let base = &rng.pick(&frames).0;
        let mut mutated = base.clone();
        for _ in 0..rng.below(9) {
            if mutated.is_empty() {
                break;
            }
            match rng.below(4) {
                0 => {
                    let pos = rng.below(mutated.len());
                    mutated[pos] ^= 1 << rng.below(8);
                }
                1 => {
                    let pos = rng.below(mutated.len());
                    mutated[pos] = rng.next_u64() as u8;
                }
                2 => {
                    let pos = rng.below(mutated.len() + 1);
                    mutated.insert(pos, rng.next_u64() as u8);
                }
                _ => {
                    let pos = rng.below(mutated.len());
                    mutated.remove(pos);
                }
            }
        }
        if rng.below(3) == 0 {
            mutated.truncate(rng.below(mutated.len() + 1));
        }
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let mut reader = BufReader::new(&mutated[..]);
            FrameDecoder::default().read_frame(&mut reader)
        }));
        match outcome {
            Ok(result) => {
                assert_in_memory_outcome(&result);
                if let Err(FrameReadError::Fault(fault)) = result {
                    if !observed.contains(&fault.code) {
                        observed.push(fault.code);
                    }
                }
            }
            Err(_) => panic!("iteration {iteration}: codec panicked on mutated input"),
        }
    }
    // Coverage note (informational): the mutation loop should hit the framing
    // classes without a size cap; the dedicated matrix asserts classification
    // and the boundary tests assert frame_too_large.
    eprintln!(
        "mutation fuzz observed fault codes: {}",
        observed
            .iter()
            .map(|code| code.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );
}

/// Deterministic classification matrix: each malformed input must map to
/// exactly the expected fault code, and each valid input to its family.
#[test]
fn codec_fuzz_error_classification_matrix() {
    // decode-level cases (direct slices; LF not required).
    let decode_cases: &[(&[u8], FaultCode)] = &[
        // invalid UTF-8, anywhere in the frame.
        (&[0xff, 0xfe], FaultCode::InvalidUtf8),
        (b"{\"a\":\"x\xffy\"}", FaultCode::InvalidUtf8),
        // valid UTF-8 that is not JSON.
        (b"this is not json", FaultCode::InvalidJson),
        // raw NUL control character inside a JSON string.
        (b"{\"a\":\"x\x00y\"}", FaultCode::InvalidJson),
        // UTF-8 BOM before any content.
        (&[0xef, 0xbb, 0xbf], FaultCode::InvalidJson),
        // empty frame.
        (b"", FaultCode::EmptyFrame),
        // JSON that is not an object.
        (b"[1,2,3]", FaultCode::InvalidEnvelope),
        (b"\"just a string\"", FaultCode::InvalidEnvelope),
        (b"null", FaultCode::InvalidEnvelope),
        (b"123", FaultCode::InvalidEnvelope),
        // envelope contract violations.
        (
            b"{\"type\":\"response\",\"id\":\"r\",\"ok\":true,\"result\":null}",
            FaultCode::ProtocolMismatch,
        ),
        (
            b"{\"protocol\":\"runtime-v2\",\"type\":\"response\",\"id\":\"r\",\"ok\":true,\"result\":null}",
            FaultCode::ProtocolMismatch,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":123}",
            FaultCode::InvalidEnvelopeType,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"request\",\"id\":\"r\"}",
            FaultCode::InvalidEnvelopeType,
        ),
        // response shape.
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"response\",\"ok\":true,\"result\":null}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"response\",\"id\":\"\",\"ok\":true,\"result\":null}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"response\",\"id\":\"r\"}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"response\",\"id\":\"r\",\"ok\":true}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"response\",\"id\":\"r\",\"ok\":false}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"response\",\"id\":\"r\",\"ok\":false,\"error\":\"nope\"}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"response\",\"id\":\"r\",\"ok\":false,\"error\":{\"code\":\"\",\"message\":\"m\",\"retryable\":false}}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"response\",\"id\":\"r\",\"ok\":false,\"error\":{\"code\":\"c\",\"message\":\"\",\"retryable\":false}}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"response\",\"id\":\"r\",\"ok\":false,\"error\":{\"code\":\"c\",\"message\":\"m\"}}",
            FaultCode::InvalidEnvelope,
        ),
        // event shape: session/runtime split, seq, sessionId.
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"event\",\"sessionId\":\"s\",\"event\":\"x.y\",\"payload\":{}}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"event\",\"seq\":1,\"event\":\"x.y\",\"payload\":{}}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"event\",\"sessionId\":\"s\",\"seq\":1,\"payload\":{}}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"event\",\"sessionId\":\"s\",\"seq\":1,\"event\":\"x.y\"}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"event\",\"sessionId\":\"\",\"seq\":1,\"event\":\"x.y\",\"payload\":{}}",
            FaultCode::InvalidEnvelope,
        ),
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"event\",\"sessionId\":5,\"seq\":1,\"event\":\"x.y\",\"payload\":{}}",
            FaultCode::InvalidEnvelope,
        ),
        // runtime-scoped events must carry the `runtime.` prefix.
        (
            b"{\"protocol\":\"runtime-v1\",\"type\":\"event\",\"event\":\"content.delta\",\"payload\":{}}",
            FaultCode::InvalidEnvelope,
        ),
    ];
    for (input, expected) in decode_cases {
        let err = FrameDecoder::default().decode(input).unwrap_err();
        assert_eq!(
            err.code,
            *expected,
            "input {}",
            String::from_utf8_lossy(input)
        );
    }

    // read-level cases: EOF mid-frame must be unterminated_frame.
    let read_cases: &[&[u8]] = &[
        b"{\"protocol\":\"runtime-v1\"",
        b"this is not json",
        b"{\"a\":1",
    ];
    for input in read_cases {
        let mut reader = BufReader::new(&input[..]);
        let err = FrameDecoder::default().read_frame(&mut reader).unwrap_err();
        match err {
            FrameReadError::Fault(fault) => assert_eq!(
                fault.code,
                FaultCode::UnterminatedFrame,
                "input {}",
                String::from_utf8_lossy(input)
            ),
            other => panic!(
                "expected unterminated_frame for {}, got {other:?}",
                String::from_utf8_lossy(input)
            ),
        }
    }

    // Empty stream is a clean EOF, not a fault.
    let mut reader = BufReader::new(&b""[..]);
    assert!(FrameDecoder::default()
        .read_frame(&mut reader)
        .unwrap()
        .is_none());

    // Valid frames classify to their expected families; unknown extra fields
    // and scalar payloads are accepted (lenient by design).
    let ok_cases: &[(&[u8], FrameKind)] = &[
        (
            br#"{"protocol":"runtime-v1","type":"response","id":"r","ok":true,"result":null}"#,
            FrameKind::OkResponse,
        ),
        (
            br#"{"protocol":"runtime-v1","type":"response","id":"r","ok":false,"error":{"code":"c","message":"m","retryable":false,"details":{"x":1}}}"#,
            FrameKind::ErrResponse,
        ),
        (
            br#"{"protocol":"runtime-v1","type":"event","sessionId":"s","seq":1,"event":"x.y","payload":{}}"#,
            FrameKind::SessionEvent,
        ),
        (
            br#"{"protocol":"runtime-v1","type":"event","event":"runtime.ready","payload":{}}"#,
            FrameKind::RuntimeEvent,
        ),
        // scalar payloads are structurally fine (payload is a free-form Value).
        (
            br#"{"protocol":"runtime-v1","type":"event","sessionId":"s","seq":2,"event":"x.y","payload":42}"#,
            FrameKind::SessionEvent,
        ),
        // a session event may use the runtime. prefix (prefix rule only
        // applies to sessionless events).
        (
            br#"{"protocol":"runtime-v1","type":"event","sessionId":"s","seq":3,"event":"runtime.warning","payload":{}}"#,
            FrameKind::SessionEvent,
        ),
        // unknown top-level fields are ignored.
        (
            br#"{"protocol":"runtime-v1","type":"response","id":"r","ok":true,"result":null,"extra":{"x":1}}"#,
            FrameKind::OkResponse,
        ),
    ];
    for (input, expected) in ok_cases {
        let frame = FrameDecoder::default()
            .decode(input)
            .unwrap_or_else(|e| panic!("input {} failed: {e}", String::from_utf8_lossy(input)));
        assert_eq!(
            kind_of(&frame),
            *expected,
            "input {}",
            String::from_utf8_lossy(input)
        );
    }
}

/// Size-cap boundaries: a frame of exactly `max` bytes decodes, `max + 1`
/// faults as `frame_too_large`, at several caps including the real 16 MiB cap.
#[test]
fn codec_fuzz_size_cap_boundaries() {
    for max in [128usize, 256, 1024, 4096, 65536] {
        let mut input = warning_frame_exactly(max);
        assert_eq!(input.len(), max);
        // The frame body is exactly `max` bytes; LF is the delimiter and is
        // excluded from the cap.
        input.push(b'\n');
        let mut reader = BufReader::new(&input[..]);
        match FrameDecoder::new(max).read_frame(&mut reader) {
            Ok(Some(OutputFrame::Event(EventFrame::Runtime { event, .. }))) => {
                assert_eq!(event, "runtime.warning", "max {max}")
            }
            other => panic!("max {max}: exact-cap frame must decode, got {other:?}"),
        }
        let mut input = warning_frame_exactly(max + 1);
        input.push(b'\n');
        let mut reader = BufReader::new(&input[..]);
        let err = FrameDecoder::new(max).read_frame(&mut reader).unwrap_err();
        match err {
            FrameReadError::Fault(fault) => {
                assert_eq!(fault.code, FaultCode::FrameTooLarge, "max {max}")
            }
            other => panic!("max {max}: expected frame_too_large, got {other:?}"),
        }
    }

    // The real 16 MiB cap (MAX_FRAME_BYTES), delimiter excluded.
    let mut input = warning_frame_exactly(MAX_FRAME_BYTES);
    assert_eq!(input.len(), MAX_FRAME_BYTES);
    input.push(b'\n');
    let mut reader = BufReader::new(&input[..]);
    assert!(matches!(
        FrameDecoder::default().read_frame(&mut reader),
        Ok(Some(OutputFrame::Event(EventFrame::Runtime { .. })))
    ));

    let mut input = warning_frame_exactly(MAX_FRAME_BYTES + 1);
    input.push(b'\n');
    let mut reader = BufReader::new(&input[..]);
    let err = FrameDecoder::default().read_frame(&mut reader).unwrap_err();
    match err {
        FrameReadError::Fault(fault) => assert_eq!(fault.code, FaultCode::FrameTooLarge),
        other => panic!("expected frame_too_large at 16MiB+1, got {other:?}"),
    }
}

/// LF boundary semantics: raw LF splits frames (even inside a JSON string),
/// escaped `\n` does not, empty frames fault, and a glued stream of frames
/// (including one spanning the BufReader's 8 KiB chunks) decodes in order.
#[test]
fn codec_fuzz_lf_split_and_multiframe_stream() {
    let decoder = FrameDecoder::default();

    // (a) A raw LF inside a JSON string splits the line. The codec frames on
    // raw bytes, so the first segment is unterminated JSON (a fault), the
    // remainder is its own (also invalid) segment, then clean EOF.
    let raw_lf_inside =
        b"{\"protocol\":\"runtime-v1\",\"type\":\"event\",\"sessionId\":\"s\",\"seq\":1,\"event\":\"x.y\",\"payload\":{\"a\":\"line1\nline2\"}}\n";
    let mut reader = BufReader::new(&raw_lf_inside[..]);
    let first = decoder.read_frame(&mut reader);
    assert!(
        matches!(
            first,
            Err(FrameReadError::Fault(ref fault)) if fault.code == FaultCode::InvalidJson
        ),
        "raw-LF split first segment must fault as invalid_json, got {first:?}"
    );
    assert_in_memory_outcome(&decoder.read_frame(&mut reader));
    assert!(decoder.read_frame(&mut reader).unwrap().is_none());

    // (b) Escaped `\n` (backslash + n) is NOT a boundary; the whole frame
    // decodes and the payload string contains a real newline.
    let escaped = b"{\"protocol\":\"runtime-v1\",\"type\":\"event\",\"sessionId\":\"s\",\"seq\":1,\"event\":\"x.y\",\"payload\":{\"a\":\"line1\\nline2\"}}\n";
    let mut reader = BufReader::new(&escaped[..]);
    match decoder.read_frame(&mut reader) {
        Ok(Some(OutputFrame::Event(EventFrame::Session { payload, .. }))) => {
            assert_eq!(payload["a"], json!("line1\nline2"));
        }
        other => panic!("escaped-\\n frame must decode as one session event, got {other:?}"),
    }
    assert!(decoder.read_frame(&mut reader).unwrap().is_none());

    // (c) LF at position 0 (and repeated LFs) are empty frames.
    let mut reader = BufReader::new(&b"\n\n"[..]);
    for _ in 0..2 {
        match decoder.read_frame(&mut reader) {
            Err(FrameReadError::Fault(fault)) => {
                assert_eq!(fault.code, FaultCode::EmptyFrame)
            }
            other => panic!("expected empty_frame, got {other:?}"),
        }
    }
    assert!(decoder.read_frame(&mut reader).unwrap().is_none());

    // (d) Glued stream: garbage, ok-response, a 24 KiB warning frame (spans
    // the BufReader's 8 KiB chunks), session event, runtime event.
    let mut stream = Vec::new();
    stream.extend_from_slice(b"garbage-no-lf\n");
    stream.extend_from_slice(
        br#"{"protocol":"runtime-v1","type":"response","id":"req-glue","ok":true,"result":null}"#,
    );
    stream.push(b'\n');
    stream.extend_from_slice(&warning_frame_with_pad(24 * 1024));
    stream.push(b'\n');
    stream.extend_from_slice(
        br#"{"protocol":"runtime-v1","type":"event","sessionId":"s","seq":7,"event":"x.y","payload":{}}"#,
    );
    stream.push(b'\n');
    stream.extend_from_slice(
        br#"{"protocol":"runtime-v1","type":"event","event":"runtime.ready","payload":{}}"#,
    );
    stream.push(b'\n');
    let mut reader = BufReader::new(&stream[..]);
    assert!(matches!(
        decoder.read_frame(&mut reader),
        Err(FrameReadError::Fault(_))
    ));
    assert!(matches!(
        decoder.read_frame(&mut reader),
        Ok(Some(OutputFrame::Response(ResponseFrame::Ok { id, .. }))) if id == "req-glue"
    ));
    assert!(matches!(
        decoder.read_frame(&mut reader),
        Ok(Some(OutputFrame::Event(EventFrame::Runtime { event, .. }))) if event == "runtime.warning"
    ));
    assert!(matches!(
        decoder.read_frame(&mut reader),
        Ok(Some(OutputFrame::Event(EventFrame::Session { seq, .. }))) if seq == 7
    ));
    assert!(matches!(
        decoder.read_frame(&mut reader),
        Ok(Some(OutputFrame::Event(EventFrame::Runtime { .. })))
    ));
    assert!(decoder.read_frame(&mut reader).unwrap().is_none());
}

/// Deeply nested payloads: 100 levels parse and classify, 1000 levels trip
/// serde_json's recursion limit (mapped to `invalid_json`) — never a panic.
#[test]
fn codec_fuzz_deeply_nested_payloads_do_not_panic() {
    let nested = |depth: usize| {
        let mut s = String::from(
            r#"{"protocol":"runtime-v1","type":"event","sessionId":"s","seq":1,"event":"x.y","payload":"#,
        );
        for _ in 0..depth {
            s.push_str("{\"x\":");
        }
        s.push_str("null");
        for _ in 0..depth {
            s.push('}');
        }
        s.push('}');
        s
    };
    match FrameDecoder::default().decode(nested(100).as_bytes()) {
        Ok(OutputFrame::Event(EventFrame::Session { .. })) => {}
        other => panic!("100-deep payload must classify as a session event, got {other:?}"),
    }
    let err = FrameDecoder::default()
        .decode(nested(1000).as_bytes())
        .unwrap_err();
    assert_eq!(
        err.code,
        FaultCode::InvalidJson,
        "1000-deep payload trips the parser recursion limit and must fault, not panic"
    );
}

/// Structural fuzz: random envelopes drawn from a pool of field/type combos
/// must be accepted or rejected structurally — never panic.
#[test]
fn codec_fuzz_random_envelopes_never_panic() {
    let mut rng = XorShift64::new(0xE0E0_2026);
    let keys = [
        "protocol",
        "type",
        "id",
        "ok",
        "result",
        "error",
        "event",
        "sessionId",
        "seq",
        "payload",
        "method",
        "params",
        "extra",
    ];
    let scalars: Vec<Value> = vec![
        Value::String("runtime-v1".into()),
        Value::String("response".into()),
        Value::String("event".into()),
        Value::String("request".into()),
        Value::String("".into()),
        Value::String("runtime.".into()),
        Value::String("x.y".into()),
        Value::Bool(true),
        Value::Bool(false),
        Value::Null,
        Value::from(0),
        Value::from(-1),
        Value::from(1),
        Value::from(1.5f64),
        Value::from(u64::MAX),
        json!([1, "a", null]),
        json!({}),
    ];
    for iteration in 0..512 {
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            let mut obj = serde_json::Map::new();
            for _ in 0..(1 + rng.below(8)) {
                obj.insert(rng.pick(&keys).to_string(), rng.pick(&scalars).clone());
            }
            let line = serde_json::to_string(&Value::Object(obj)).unwrap();
            FrameDecoder::default().decode(line.as_bytes())
        }));
        match outcome {
            Ok(Ok(_frame)) => {}
            Ok(Err(_fault)) => {}
            Err(_) => panic!("iteration {iteration}: codec panicked on a random envelope"),
        }
    }
}

/// `seq` shape validation: positive integers (up to u64::MAX) pass, anything
/// else is `invalid_envelope`. The codec deliberately does NOT enforce
/// monotonic ordering — out-of-order positive seqs decode fine here and are
/// the consumer's (host/translate) concern.
#[test]
fn codec_fuzz_event_seq_shape_validation() {
    let decoder = FrameDecoder::default();
    for seq in ["1", "3", "9223372036854775807", "18446744073709551615"] {
        let line = format!(
            r#"{{"protocol":"runtime-v1","type":"event","sessionId":"s","seq":{seq},"event":"x.y","payload":{{}}}}"#
        );
        assert!(
            matches!(
                decoder.decode(line.as_bytes()),
                Ok(OutputFrame::Event(EventFrame::Session { .. }))
            ),
            "seq {seq} must be accepted"
        );
    }
    for (seq, expected) in [
        ("0", FaultCode::InvalidEnvelope),
        ("-1", FaultCode::InvalidEnvelope),
        ("1.5", FaultCode::InvalidEnvelope),
        ("\"1\"", FaultCode::InvalidEnvelope),
        ("true", FaultCode::InvalidEnvelope),
        ("null", FaultCode::InvalidEnvelope),
    ] {
        let line = format!(
            r#"{{"protocol":"runtime-v1","type":"event","sessionId":"s","seq":{seq},"event":"x.y","payload":{{}}}}"#
        );
        let err = decoder.decode(line.as_bytes()).unwrap_err();
        assert_eq!(err.code, expected, "seq {seq}");
    }
}

/// Request-side (encode) edge cases: minimal params serialize, oversized
/// params are rejected at the cap rather than truncated.
#[test]
fn codec_fuzz_encode_request_edge_cases() {
    let frame = RequestFrame::new("req-0", "x", json!({}));
    let line = encode_request(&frame, MAX_FRAME_BYTES).unwrap();
    assert!(line.ends_with('\n'));
    let big = RequestFrame::new("req-0", "x", json!({"pad": "a".repeat(4096)}));
    let err = encode_request(&big, 1024).unwrap_err();
    assert_eq!(err.code, FaultCode::FrameTooLarge);
}

/// Report-only finding: `read_frame` computes `max_frame_bytes + 1` with a
/// plain addition before the saturating subtraction, so `FrameDecoder::new(
/// usize::MAX)` overflows and panics in debug builds (wraps to a silent
/// frame_too_large in release). Constructor accepts the value, so this is a
/// latent contract violation; the main agent decides whether to fix.
/// Regression: `FrameDecoder::new(usize::MAX)` used to overflow `max + 1`
/// in `read_frame_bytes` (debug panic / release wrap). Fixed with
/// `saturating_add`; an unbounded decoder now just reads. Completing this
/// call at all is the assertion — pre-fix it panicked before any I/O.
#[test]
fn codec_fuzz_usize_max_frame_size_reads_without_panic() {
    let decoder = FrameDecoder::new(usize::MAX);
    let mut reader = BufReader::new(&b"{}"[..]);
    let _ = decoder.read_frame(&mut reader);
}

// ===========================================================================
// Layer 2: supervisor fail-closed fuzz (node fixture worker; skipped without
// node).
// ===========================================================================

/// Kimi source commit pinned by the migration contract (M0 freeze).
const EXPECTED_COMMIT: &str = "53c832dfdf9566afd59a8b3d54ebd36d3cb03d72";
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

fn node_on_path() -> bool {
    Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Returns false (after noting why) when the test cannot run.
fn node_or_skip(test: &str) -> bool {
    if node_on_path() {
        return true;
    }
    eprintln!("skipping {test}: `node` was not found on PATH");
    false
}

fn fixture_config(extra_env: &[(&str, &str)]) -> SpawnConfig {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("runtime-fixture-worker.mjs");
    SpawnConfig {
        program: "node".to_string(),
        args: vec![fixture.to_string_lossy().into_owned()],
        env: extra_env
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
        cwd: None,
    }
}

fn handshake_config() -> HandshakeConfig {
    HandshakeConfig {
        hello: HelloParams::new(
            env!("CARGO_PKG_VERSION"),
            std::env::temp_dir().to_string_lossy().into_owned(),
            std::env::consts::OS,
            std::env::consts::ARCH,
            "en-US",
        ),
        expected_commit: Some(EXPECTED_COMMIT.to_string()),
        timeout: CALL_TIMEOUT,
    }
}

/// One env-fault case for the fail-closed matrix: name, supervisor options,
/// and the fixture env injections.
type EnvFaultCase = (
    &'static str,
    SupervisorOptions,
    Vec<(&'static str, &'static str)>,
);

/// The three existing env fault injections, run as a fail-closed matrix: the
/// supervisor reaches `Failed`, the recorded fault has the expected kind, a
/// request left pending while the fault lands settles (no hang), stderr keeps
/// diagnostics, and the fail-closed path is idempotent (further triggers
/// neither panic nor replace the first fault).
#[test]
fn supervisor_fuzz_env_faults_fail_closed_matrix() {
    if !node_or_skip("env_faults") {
        return;
    }
    let faults: Vec<EnvFaultCase> = vec![
        (
            "invalid_json",
            SupervisorOptions::default(),
            vec![("KIMI_RUNTIME_FIXTURE_RAW_STDOUT", "this is not json")],
        ),
        (
            "frame_too_large",
            SupervisorOptions {
                max_frame_bytes: 64 * 1024,
                ..SupervisorOptions::default()
            },
            vec![("KIMI_RUNTIME_FIXTURE_HUGE_BYTES", "131072")],
        ),
        (
            "duplicate_response_id",
            SupervisorOptions::default(),
            vec![("KIMI_RUNTIME_FIXTURE_DUPLICATE_RESPONSES", "1")],
        ),
    ];
    for (name, options, env) in &faults {
        let supervisor = RuntimeSupervisor::with_options(fixture_config(env), *options);
        supervisor.start().expect("spawn fixture worker");
        assert_eq!(supervisor.state(), SupervisorState::Handshaking, "{name}");

        // A request the fixture never answers stays pending until the fault
        // lands; fail-closed must settle it (bounded by the 5 s timeout).
        // One legitimate race: before hello, the fixture answers any method
        // with a structured `handshake_required` rejection, so `Rejected` is
        // an allowed outcome too — the no-hang property is still proven by
        // the hello request inside `handshake` settling on every case below.
        let settled = std::thread::scope(|scope| {
            let handle = scope.spawn(|| {
                supervisor.call("fixture.neverRespond", json!({}), Duration::from_secs(5))
            });
            // Give the pending write a moment to land before the fault does.
            std::thread::sleep(Duration::from_millis(50));
            handle.join()
        });
        let pending_err = settled
            .expect("concurrent request thread panicked")
            .expect_err("pending request must settle with an error, not hang");
        assert!(
            matches!(
                pending_err,
                RuntimeError::Protocol(_)
                    | RuntimeError::DuplicateResponseId(_)
                    | RuntimeError::Rejected(_)
                    | RuntimeError::InvalidState(_)
                    | RuntimeError::Io(_)
            ),
            "{name}: unexpected pending outcome {pending_err:?}"
        );

        let handshake_err = supervisor.handshake(&handshake_config()).unwrap_err();
        assert!(
            matches!(
                handshake_err,
                RuntimeError::Protocol(_)
                    | RuntimeError::DuplicateResponseId(_)
                    | RuntimeError::InvalidState(_)
                    | RuntimeError::Io(_)
            ),
            "{name}: unexpected handshake outcome {handshake_err:?}"
        );
        assert_eq!(supervisor.state(), SupervisorState::Failed, "{name}");

        // The recorded fault is the contract; first fault wins.
        let recorded = supervisor.fault().expect("fault recorded");
        match *name {
            "invalid_json" => assert!(matches!(
                recorded,
                RuntimeError::Protocol(ref fault) if fault.code == FaultCode::InvalidJson
            )),
            "frame_too_large" => assert!(matches!(
                recorded,
                RuntimeError::Protocol(ref fault) if fault.code == FaultCode::FrameTooLarge
            )),
            "duplicate_response_id" => {
                assert!(matches!(recorded, RuntimeError::DuplicateResponseId(_)))
            }
            other => unreachable!("unexpected fault name {other}"),
        }

        // stderr diagnostics survive for the crash report.
        assert!(
            supervisor
                .stderr_tail(20)
                .iter()
                .any(|line| line.contains("[runtime-fixture] starting")),
            "{name}: expected fixture diagnostics on stderr"
        );

        // Fail-closed is idempotent: further triggers neither panic nor
        // replace the first fault; shutdown on Failed is a no-op.
        let err = supervisor
            .call("runtime.getInfo", json!({}), CALL_TIMEOUT)
            .unwrap_err();
        assert!(matches!(err, RuntimeError::InvalidState(_)), "{name}");
        assert!(
            supervisor.shutdown(&ShutdownConfig::default()).is_ok(),
            "{name}"
        );
        assert_eq!(
            supervisor.fault(),
            Some(recorded),
            "{name}: first fault must win"
        );
    }
}

/// SIGKILL the fixture mid-handshake (unix only): a `node -e` wrapper spawns
/// the fixture worker with inherited stdio and kills it with SIGKILL 300 ms
/// after spawn, while the supervisor is still in `Handshaking`. The
/// supervisor must fail closed with `UnexpectedExit` (status 137 =
/// 128 + SIGKILL), keep the stderr ring, and stay idempotent afterwards.
#[test]
fn supervisor_fuzz_kill_mid_handshake_sigkill() {
    if !node_or_skip("kill_mid_handshake") {
        return;
    }
    if !cfg!(unix) {
        eprintln!("skipping kill_mid_handshake: the SIGKILL wrapper needs a unix shell");
        return;
    }
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("runtime-fixture-worker.mjs");
    // The supervisor's direct child is `node -e`, which spawns the fixture
    // with inherited stdio (keeps the real stdin pipe — a backgrounded child
    // in `sh -c` would get /dev/null stdin and exit 0 immediately) and
    // SIGKILLs it 300 ms in, then exits 137 (128 + SIGKILL).
    let script = format!(
        "const{{spawn}}=require('node:child_process');const c=spawn('node',['{}'],{{stdio:'inherit'}});c.on('exit',(code,signal)=>process.exit(signal==='SIGKILL'?137:(code??1)));setTimeout(()=>c.kill('SIGKILL'),300);",
        fixture.to_string_lossy()
    );
    let supervisor = RuntimeSupervisor::new(SpawnConfig {
        program: "node".to_string(),
        args: vec!["-e".to_string(), script],
        env: vec![],
        cwd: None,
    });
    supervisor.start().expect("spawn wrapper");
    assert_eq!(supervisor.state(), SupervisorState::Handshaking);

    // The child dies by SIGKILL; the stdout pump observes EOF and fails
    // closed. Poll for the transition (bounded).
    let deadline = Instant::now() + Duration::from_secs(5);
    while supervisor.state() != SupervisorState::Failed && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(supervisor.state(), SupervisorState::Failed);
    match supervisor.fault() {
        Some(RuntimeError::UnexpectedExit { code }) => {
            assert_eq!(code, Some(137), "expected 137 (128 + SIGKILL)")
        }
        other => panic!("expected UnexpectedExit fault, got {other:?}"),
    }
    assert_eq!(supervisor.exit_status().and_then(|s| s.code()), Some(137));
    assert!(
        supervisor
            .stderr_tail(20)
            .iter()
            .any(|line| line.contains("[runtime-fixture] starting")),
        "fixture diagnostics must be captured for the crash report"
    );
    // Idempotent fail-closed: later calls reject, shutdown is a no-op.
    let err = supervisor
        .call("runtime.getInfo", json!({}), CALL_TIMEOUT)
        .unwrap_err();
    assert!(matches!(err, RuntimeError::InvalidState(_)));
    assert!(supervisor.shutdown(&ShutdownConfig::default()).is_ok());
}

/// Writes after terminal states: a stopped supervisor rejects with
/// "already stopped", a failed one with "failed", and shutdown is idempotent
/// on both — nothing hangs, nothing panics.
#[test]
fn supervisor_fuzz_write_after_shutdown_and_fail_closed() {
    if !node_or_skip("write_after_shutdown") {
        return;
    }
    let supervisor = RuntimeSupervisor::new(fixture_config(&[]));
    supervisor.start().expect("spawn fixture worker");
    supervisor
        .handshake(&handshake_config())
        .expect("handshake");
    supervisor
        .shutdown(&ShutdownConfig::default())
        .expect("clean shutdown");
    assert_eq!(supervisor.state(), SupervisorState::Stopped);
    let err = supervisor
        .call("runtime.getInfo", json!({}), CALL_TIMEOUT)
        .unwrap_err();
    assert!(
        matches!(err, RuntimeError::InvalidState(message) if message.contains("stopped")),
        "stopped supervisor must reject writes with a stopped message, got {err:?}"
    );
    let err = supervisor
        .call_with_session("session.open", "s-1", json!({}), CALL_TIMEOUT)
        .unwrap_err();
    assert!(matches!(err, RuntimeError::InvalidState(_)));
    assert!(
        supervisor.shutdown(&ShutdownConfig::default()).is_ok(),
        "shutdown on Stopped is idempotent"
    );

    let supervisor = RuntimeSupervisor::new(fixture_config(&[(
        "KIMI_RUNTIME_FIXTURE_RAW_STDOUT",
        "this is not json",
    )]));
    supervisor.start().expect("spawn fixture worker");
    let _ = supervisor.handshake(&handshake_config());
    assert_eq!(supervisor.state(), SupervisorState::Failed);
    let err = supervisor
        .call("runtime.getInfo", json!({}), CALL_TIMEOUT)
        .unwrap_err();
    assert!(
        matches!(err, RuntimeError::InvalidState(message) if message.contains("failed")),
        "failed supervisor must reject writes with a failed message, got {err:?}"
    );
    assert!(
        supervisor.shutdown(&ShutdownConfig::default()).is_ok(),
        "shutdown on Failed is a no-op"
    );
}

/// Randomized sequences of legal calls (getInfo, hello-after-handshake,
/// parity methods, unknown methods, slow/never responders) in shuffled order
/// must never move the supervisor out of `Ready` or fault it closed; only
/// `Rejected`/`Timeout` outcomes are legal before a clean shutdown.
#[test]
fn supervisor_fuzz_random_call_sequences() {
    if !node_or_skip("random_call_sequences") {
        return;
    }
    for seed in [0x11u64, 0x22, 0x33] {
        let mut rng = XorShift64::new(seed);
        let supervisor = RuntimeSupervisor::new(fixture_config(&[]));
        supervisor.start().expect("spawn fixture worker");
        supervisor
            .handshake(&handshake_config())
            .expect("handshake");

        let mut calls: Vec<(&str, Value, Duration)> = vec![
            ("runtime.getInfo", json!({}), CALL_TIMEOUT),
            // hello after the handshake completes: the fixture answers a
            // structured rejection, which must stay non-fatal.
            ("runtime.hello", json!({}), CALL_TIMEOUT),
            // parity methods answer not_implemented via error-responses.
            ("session.replay", json!({}), CALL_TIMEOUT),
            ("providers.catalog.list", json!({}), CALL_TIMEOUT),
            ("session.setMode", json!({}), CALL_TIMEOUT),
            ("unknown.method.xyz", json!({}), CALL_TIMEOUT),
            ("fixture.slowRespond", json!({"delayMs": 1}), CALL_TIMEOUT),
            (
                "fixture.emitScript",
                json!({"sessionId": "fuzz-session"}),
                CALL_TIMEOUT,
            ),
            // The fixture never answers; a short timeout bounds the local
            // wait and the outcome is a Timeout, not a fault.
            (
                "fixture.neverRespond",
                json!({}),
                Duration::from_millis(150),
            ),
        ];
        // Deterministic Fisher-Yates shuffle with the PRNG.
        for index in (1..calls.len()).rev() {
            let other = rng.below(index + 1);
            calls.swap(index, other);
        }
        for (method, params, timeout) in calls {
            let result = supervisor.call(method, params, timeout);
            match result {
                Ok(_) => {}
                Err(RuntimeError::Rejected(_)) | Err(RuntimeError::Timeout(_)) => {}
                Err(other) => {
                    panic!("seed {seed:#x}: {method} must not fault the supervisor, got {other:?}")
                }
            }
            assert_eq!(
                supervisor.state(),
                SupervisorState::Ready,
                "seed {seed:#x}: state after {method}"
            );
        }
        supervisor
            .shutdown(&ShutdownConfig::default())
            .expect("clean shutdown");
        assert_eq!(supervisor.state(), SupervisorState::Stopped);
    }
}
