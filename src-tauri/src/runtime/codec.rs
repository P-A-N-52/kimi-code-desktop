//! runtime-v1 stdio JSONL codec: request encoding and size-capped frame
//! decoding for the runtime's stdout.
//!
//! Contract authority: `runtime/kimi-code/apps/desktop-runtime/src/protocol.ts`
//! and `codec.ts`. Stdout carries LF-delimited UTF-8 JSON envelopes, one frame
//! per line, with a hard 16 MiB frame cap (delimiter excluded). Any framing
//! violation is a protocol fault; the supervisor fails the runtime closed on
//! every one.

use super::protocol::{
    ErrorBody, EventFrame, FaultCode, OutputFrame, ProtocolFault, RequestFrame, ResponseFrame,
    MAX_FRAME_BYTES, RUNTIME_EVENT_PREFIX, RUNTIME_PROTOCOL,
};
use serde_json::Value;
use std::fmt;
use std::io::BufRead;

/// Serialize a request into one LF-terminated output line, size-capped.
pub fn encode_request(
    frame: &RequestFrame,
    max_frame_bytes: usize,
) -> Result<String, ProtocolFault> {
    let json = serde_json::to_string(frame).map_err(|err| {
        ProtocolFault::new(
            FaultCode::InvalidEnvelope,
            format!("request frame is not serializable: {err}"),
        )
    })?;
    if json.len() > max_frame_bytes {
        return Err(ProtocolFault::new(
            FaultCode::FrameTooLarge,
            format!("request frame exceeds the {max_frame_bytes}-byte limit"),
        ));
    }
    Ok(format!("{json}\n"))
}

/// Size-capped LF-delimited frame decoder for the runtime's stdout.
#[derive(Debug, Clone, Copy)]
pub struct FrameDecoder {
    max_frame_bytes: usize,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self {
            max_frame_bytes: MAX_FRAME_BYTES,
        }
    }
}

impl FrameDecoder {
    /// `max_frame_bytes` excludes the LF delimiter, matching the runtime codec.
    pub fn new(max_frame_bytes: usize) -> Self {
        Self { max_frame_bytes }
    }

    /// Decode one already size-checked frame (LF delimiter stripped).
    pub fn decode(&self, bytes: &[u8]) -> Result<OutputFrame, ProtocolFault> {
        if bytes.is_empty() {
            return Err(ProtocolFault::new(
                FaultCode::EmptyFrame,
                "runtime output contains an empty frame",
            ));
        }
        if bytes.len() > self.max_frame_bytes {
            return Err(ProtocolFault::new(
                FaultCode::FrameTooLarge,
                format!("frame exceeds the {}-byte limit", self.max_frame_bytes),
            ));
        }
        let text = std::str::from_utf8(bytes)
            .map_err(|_| ProtocolFault::new(FaultCode::InvalidUtf8, "frame is not valid UTF-8"))?;
        let value: Value = serde_json::from_str(text)
            .map_err(|_| ProtocolFault::new(FaultCode::InvalidJson, "frame is not valid JSON"))?;
        classify_frame(&value)
    }

    /// Read and decode one LF-terminated frame. `Ok(None)` is a clean EOF
    /// (stream ended between frames); EOF mid-frame is `UnterminatedFrame`.
    pub fn read_frame<R: BufRead>(
        &self,
        reader: &mut R,
    ) -> Result<Option<OutputFrame>, FrameReadError> {
        match read_frame_bytes(reader, self.max_frame_bytes)? {
            None => Ok(None),
            Some(bytes) => Ok(Some(self.decode(&bytes)?)),
        }
    }
}

/// Failure of `FrameDecoder::read_frame`: a protocol fault or a stream I/O
/// error (the latter usually means the child died).
#[derive(Debug)]
pub enum FrameReadError {
    Fault(ProtocolFault),
    Io(std::io::Error),
}

impl From<ProtocolFault> for FrameReadError {
    fn from(fault: ProtocolFault) -> Self {
        Self::Fault(fault)
    }
}

impl From<std::io::Error> for FrameReadError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

impl fmt::Display for FrameReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fault(fault) => write!(f, "{fault}"),
            Self::Io(err) => write!(f, "io error: {err}"),
        }
    }
}

impl std::error::Error for FrameReadError {}

/// Read one LF-delimited frame body, never buffering more than `max + 1`
/// bytes. Returns `Ok(None)` on clean EOF.
fn read_frame_bytes<R: BufRead>(
    reader: &mut R,
    max_frame_bytes: usize,
) -> Result<Option<Vec<u8>>, FrameReadError> {
    let mut buf = Vec::new();
    loop {
        let room = (max_frame_bytes + 1).saturating_sub(buf.len());
        if room == 0 {
            return Err(frame_too_large(max_frame_bytes).into());
        }
        // fill_buf/consume keeps the borrow scoped: copy out at most `room`
        // bytes, stop at the LF delimiter, then consume what was copied.
        let (consumed, found_lf) = {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                if buf.is_empty() {
                    return Ok(None);
                }
                return Err(ProtocolFault::new(
                    FaultCode::UnterminatedFrame,
                    "stream ended before the final LF delimiter",
                )
                .into());
            }
            match available.iter().position(|byte| *byte == b'\n') {
                // The LF must fit inside the cap: `pos < room` keeps the frame
                // body at `<= max` bytes; otherwise the frame is oversized.
                Some(pos) if pos < room => {
                    buf.extend_from_slice(&available[..pos]);
                    (pos + 1, true)
                }
                _ => {
                    let take = available.len().min(room);
                    buf.extend_from_slice(&available[..take]);
                    (take, false)
                }
            }
        };
        reader.consume(consumed);
        if found_lf {
            return Ok(Some(buf));
        }
        if buf.len() > max_frame_bytes {
            return Err(frame_too_large(max_frame_bytes).into());
        }
    }
}

fn frame_too_large(max_frame_bytes: usize) -> ProtocolFault {
    ProtocolFault::new(
        FaultCode::FrameTooLarge,
        format!("frame exceeds the {max_frame_bytes}-byte limit"),
    )
}

/// Classify a parsed JSON value into a response or event frame, enforcing the
/// envelope contract (`protocol`, `type`, and per-kind mandatory fields).
fn classify_frame(value: &Value) -> Result<OutputFrame, ProtocolFault> {
    let obj = value.as_object().ok_or_else(|| {
        ProtocolFault::new(FaultCode::InvalidEnvelope, "frame must be a JSON object")
    })?;
    if obj.get("protocol").and_then(Value::as_str) != Some(RUNTIME_PROTOCOL) {
        return Err(ProtocolFault::new(
            FaultCode::ProtocolMismatch,
            format!("expected protocol {RUNTIME_PROTOCOL}"),
        ));
    }
    match obj.get("type").and_then(Value::as_str) {
        Some("response") => parse_response(obj).map(OutputFrame::Response),
        Some("event") => parse_event(obj).map(OutputFrame::Event),
        _ => Err(ProtocolFault::new(
            FaultCode::InvalidEnvelopeType,
            "frame type must be `response` or `event`",
        )),
    }
}

fn parse_response(obj: &serde_json::Map<String, Value>) -> Result<ResponseFrame, ProtocolFault> {
    let id = required_str(obj, "id")?.to_string();
    let ok = obj.get("ok").and_then(Value::as_bool).ok_or_else(|| {
        ProtocolFault::new(
            FaultCode::InvalidEnvelope,
            "response `ok` must be a boolean",
        )
    })?;
    if ok {
        let result = obj.get("result").cloned().ok_or_else(|| {
            ProtocolFault::new(
                FaultCode::InvalidEnvelope,
                "ok response is missing `result`",
            )
        })?;
        return Ok(ResponseFrame::Ok { id, result });
    }
    let error_value = obj.get("error").cloned().ok_or_else(|| {
        ProtocolFault::new(
            FaultCode::InvalidEnvelope,
            "error response is missing `error`",
        )
    })?;
    let error: ErrorBody = serde_json::from_value(error_value).map_err(|err| {
        ProtocolFault::new(
            FaultCode::InvalidEnvelope,
            format!("response error body is malformed: {err}"),
        )
    })?;
    if error.code.is_empty() || error.message.is_empty() {
        return Err(ProtocolFault::new(
            FaultCode::InvalidEnvelope,
            "response error code/message must be non-empty",
        ));
    }
    Ok(ResponseFrame::Err { id, error })
}

fn parse_event(obj: &serde_json::Map<String, Value>) -> Result<EventFrame, ProtocolFault> {
    let event = required_str(obj, "event")?.to_string();
    let session_id = match obj.get("sessionId") {
        None => None,
        Some(value) => Some(value.as_str().filter(|s| !s.is_empty()).ok_or_else(|| {
            ProtocolFault::new(
                FaultCode::InvalidEnvelope,
                "event `sessionId` must be non-empty",
            )
        })?),
    };
    let seq = match obj.get("seq") {
        None => None,
        Some(value) => Some(value.as_u64().filter(|seq| *seq > 0).ok_or_else(|| {
            ProtocolFault::new(
                FaultCode::InvalidEnvelope,
                "event `seq` must be a positive integer",
            )
        })?),
    };
    let payload = obj.get("payload").cloned().ok_or_else(|| {
        ProtocolFault::new(FaultCode::InvalidEnvelope, "event is missing `payload`")
    })?;
    match (session_id, seq) {
        (Some(session_id), Some(seq)) => Ok(EventFrame::Session {
            session_id: session_id.to_string(),
            seq,
            event,
            payload,
        }),
        (None, None) => {
            if !event.starts_with(RUNTIME_EVENT_PREFIX) {
                return Err(ProtocolFault::new(
                    FaultCode::InvalidEnvelope,
                    format!("runtime-scoped event must use the `{RUNTIME_EVENT_PREFIX}` prefix"),
                ));
            }
            Ok(EventFrame::Runtime { event, payload })
        }
        _ => Err(ProtocolFault::new(
            FaultCode::InvalidEnvelope,
            "session events require `sessionId` and `seq` together",
        )),
    }
}

fn required_str<'a>(
    obj: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Result<&'a str, ProtocolFault> {
    obj.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ProtocolFault::new(
                FaultCode::InvalidEnvelope,
                format!("frame `{key}` must be a non-empty string"),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::super::protocol::{METHOD_GET_INFO, RUNTIME_PROTOCOL};
    use super::*;
    use serde_json::json;
    use std::io::BufReader;

    fn decode_str(line: &str) -> Result<OutputFrame, ProtocolFault> {
        FrameDecoder::default().decode(line.as_bytes())
    }

    #[test]
    fn encode_request_matches_contract_shape() {
        let frame = RequestFrame::new("req-1", METHOD_GET_INFO, json!({}));
        let line = encode_request(&frame, MAX_FRAME_BYTES).unwrap();
        assert!(line.ends_with('\n'));
        let value: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(value["protocol"], json!(RUNTIME_PROTOCOL));
        assert_eq!(value["type"], json!("request"));
        assert_eq!(value["id"], json!("req-1"));
        assert_eq!(value["method"], json!("runtime.getInfo"));
        assert_eq!(value["params"], json!({}));
        assert!(value.get("sessionId").is_none());
    }

    #[test]
    fn encode_request_includes_session_id_when_set() {
        let frame = RequestFrame::new("req-2", "session.open", json!({"sessionId": "s-1"}))
            .with_session("s-1");
        let line = encode_request(&frame, MAX_FRAME_BYTES).unwrap();
        let value: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(value["sessionId"], json!("s-1"));
    }

    #[test]
    fn encode_request_enforces_size_cap() {
        let frame = RequestFrame::new("req-3", "x", json!({"pad": "a".repeat(1024)}));
        let err = encode_request(&frame, 64).unwrap_err();
        assert_eq!(err.code, FaultCode::FrameTooLarge);
    }

    #[test]
    fn decode_ok_response() {
        let frame = decode_str(
            r#"{"protocol":"runtime-v1","type":"response","id":"req-1","ok":true,"result":{"a":1}}"#,
        )
        .unwrap();
        assert_eq!(
            frame,
            OutputFrame::Response(ResponseFrame::Ok {
                id: "req-1".to_string(),
                result: json!({"a": 1}),
            })
        );
    }

    #[test]
    fn decode_error_response() {
        let frame = decode_str(
            r#"{"protocol":"runtime-v1","type":"response","id":"req-9","ok":false,"error":{"code":"method_not_found","message":"nope","retryable":false}}"#,
        )
        .unwrap();
        match frame {
            OutputFrame::Response(ResponseFrame::Err { id, error }) => {
                assert_eq!(id, "req-9");
                assert_eq!(error.code, "method_not_found");
                assert_eq!(error.message, "nope");
                assert!(!error.retryable);
                assert_eq!(error.details, None);
            }
            other => panic!("expected error response, got {other:?}"),
        }
    }

    #[test]
    fn decode_ok_response_requires_result() {
        let err = decode_str(r#"{"protocol":"runtime-v1","type":"response","id":"r","ok":true}"#)
            .unwrap_err();
        assert_eq!(err.code, FaultCode::InvalidEnvelope);
    }

    #[test]
    fn decode_session_event() {
        let frame = decode_str(
            r#"{"protocol":"runtime-v1","type":"event","sessionId":"s-1","seq":3,"event":"content.delta","payload":{"text":"hi"}}"#,
        )
        .unwrap();
        assert_eq!(
            frame,
            OutputFrame::Event(EventFrame::Session {
                session_id: "s-1".to_string(),
                seq: 3,
                event: "content.delta".to_string(),
                payload: json!({"text": "hi"}),
            })
        );
    }

    #[test]
    fn decode_runtime_event() {
        let frame = decode_str(
            r#"{"protocol":"runtime-v1","type":"event","event":"runtime.ready","payload":{}}"#,
        )
        .unwrap();
        assert_eq!(
            frame,
            OutputFrame::Event(EventFrame::Runtime {
                event: "runtime.ready".to_string(),
                payload: json!({}),
            })
        );
    }

    #[test]
    fn decode_runtime_event_requires_prefix() {
        let err = decode_str(
            r#"{"protocol":"runtime-v1","type":"event","event":"content.delta","payload":{}}"#,
        )
        .unwrap_err();
        assert_eq!(err.code, FaultCode::InvalidEnvelope);
    }

    #[test]
    fn decode_session_event_requires_seq_and_session_together() {
        let missing_seq = decode_str(
            r#"{"protocol":"runtime-v1","type":"event","sessionId":"s-1","event":"content.delta","payload":{}}"#,
        )
        .unwrap_err();
        assert_eq!(missing_seq.code, FaultCode::InvalidEnvelope);
        let missing_session = decode_str(
            r#"{"protocol":"runtime-v1","type":"event","seq":1,"event":"runtime.ready","payload":{}}"#,
        )
        .unwrap_err();
        assert_eq!(missing_session.code, FaultCode::InvalidEnvelope);
    }

    #[test]
    fn decode_rejects_protocol_mismatch() {
        let err = decode_str(
            r#"{"protocol":"runtime-v2","type":"response","id":"r","ok":true,"result":null}"#,
        )
        .unwrap_err();
        assert_eq!(err.code, FaultCode::ProtocolMismatch);
    }

    #[test]
    fn decode_rejects_unknown_frame_type() {
        let err = decode_str(r#"{"protocol":"runtime-v1","type":"request","id":"r"}"#).unwrap_err();
        assert_eq!(err.code, FaultCode::InvalidEnvelopeType);
    }

    #[test]
    fn decode_rejects_invalid_json_and_empty_frames() {
        let err = decode_str("this is not json").unwrap_err();
        assert_eq!(err.code, FaultCode::InvalidJson);
        let err = FrameDecoder::default().decode(b"").unwrap_err();
        assert_eq!(err.code, FaultCode::EmptyFrame);
        let err = decode_str("[1,2,3]").unwrap_err();
        assert_eq!(err.code, FaultCode::InvalidEnvelope);
    }

    #[test]
    fn decode_rejects_invalid_utf8() {
        let err = FrameDecoder::default().decode(&[0xff, 0xfe]).unwrap_err();
        assert_eq!(err.code, FaultCode::InvalidUtf8);
    }

    #[test]
    fn decode_enforces_size_cap() {
        let line = format!(
            r#"{{"protocol":"runtime-v1","type":"event","event":"runtime.warning","payload":{{"pad":"{}"}}}}"#,
            "a".repeat(1024)
        );
        let err = FrameDecoder::new(64).decode(line.as_bytes()).unwrap_err();
        assert_eq!(err.code, FaultCode::FrameTooLarge);
    }

    #[test]
    fn read_frame_streams_multiple_frames() {
        let input = b"{\"protocol\":\"runtime-v1\",\"type\":\"event\",\"event\":\"runtime.ready\",\"payload\":{}}\n{\"protocol\":\"runtime-v1\",\"type\":\"response\",\"id\":\"r\",\"ok\":true,\"result\":null}\n";
        let mut reader = BufReader::new(&input[..]);
        let decoder = FrameDecoder::default();
        assert!(matches!(
            decoder.read_frame(&mut reader).unwrap(),
            Some(OutputFrame::Event(EventFrame::Runtime { .. }))
        ));
        assert!(matches!(
            decoder.read_frame(&mut reader).unwrap(),
            Some(OutputFrame::Response(ResponseFrame::Ok { .. }))
        ));
        assert!(decoder.read_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn read_frame_accepts_frame_exactly_at_cap() {
        // Frame body of exactly `max` bytes followed by LF must pass.
        let body = format!(
            "{{\"protocol\":\"runtime-v1\",\"type\":\"event\",\"event\":\"runtime.warning\",\"payload\":{{\"pad\":\"{}\"}}}}",
            "a".repeat(64)
        );
        let max = body.len();
        let input = format!("{body}\n");
        let mut reader = BufReader::new(input.as_bytes());
        let frame = FrameDecoder::new(max).read_frame(&mut reader).unwrap();
        assert!(matches!(frame, Some(OutputFrame::Event(_))));
    }

    #[test]
    fn read_frame_rejects_frame_one_byte_over_cap() {
        let body = format!(
            "{{\"protocol\":\"runtime-v1\",\"type\":\"event\",\"event\":\"runtime.warning\",\"payload\":{{\"pad\":\"{}\"}}}}",
            "a".repeat(64)
        );
        let max = body.len() - 1;
        let input = format!("{body}\n");
        let mut reader = BufReader::new(input.as_bytes());
        let err = FrameDecoder::new(max).read_frame(&mut reader).unwrap_err();
        match err {
            FrameReadError::Fault(fault) => assert_eq!(fault.code, FaultCode::FrameTooLarge),
            other => panic!("expected frame_too_large, got {other:?}"),
        }
    }

    #[test]
    fn read_frame_rejects_unterminated_tail() {
        let input = b"{\"protocol\":\"runtime-v1\"";
        let mut reader = BufReader::new(&input[..]);
        let err = FrameDecoder::default().read_frame(&mut reader).unwrap_err();
        match err {
            FrameReadError::Fault(fault) => assert_eq!(fault.code, FaultCode::UnterminatedFrame),
            other => panic!("expected unterminated_frame, got {other:?}"),
        }
    }
}
