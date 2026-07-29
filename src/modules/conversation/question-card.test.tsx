import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuestionCard } from "./question-card";

describe("QuestionCard", () => {
  it("shows free-text Other input and submits custom answers", () => {
    const onRespond = vi.fn();
    render(
      <QuestionCard
        question={{
          id: "7",
          toolCallId: "1:ask:question:0",
          questions: [
            {
              question: "Which approach should we take?",
              header: "Which approach should we take?",
              options: [
                { label: "Ship it", description: "" },
                { label: "Keep iterating", description: "" },
              ],
              multi_select: false,
              other_label: "其他",
            },
          ],
          submitted: false,
          resolved: false,
        }}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByText("Kimi 想确认几个问题")).toBeTruthy();
    const other = screen.getByRole("textbox", { name: "其他" });
    fireEvent.change(other, { target: { value: "用 postgres，别折腾" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    expect(onRespond).toHaveBeenCalledWith("7", {
      "Which approach should we take?": "用 postgres，别折腾",
    });
  });

  it("submits a selected option label", () => {
    const onRespond = vi.fn();
    render(
      <QuestionCard
        question={{
          id: "8",
          toolCallId: "1:ask:question:0",
          questions: [
            {
              question: "Pick one",
              header: "Pick one",
              options: [
                { label: "Alpha", description: "first" },
                { label: "Beta", description: "second" },
              ],
              multi_select: false,
            },
          ],
          submitted: false,
          resolved: false,
        }}
        onRespond={onRespond}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onRespond).toHaveBeenCalledWith("8", { "Pick one": "Alpha" });
  });

  it("shows answered summary when resolved", () => {
    render(
      <QuestionCard
        question={{
          id: "9",
          toolCallId: "1:ask:question:0",
          questions: [
            {
              question: "Pick one",
              header: "Pick one",
              options: [
                { label: "Alpha", description: "first" },
                { label: "Beta", description: "second" },
              ],
              multi_select: false,
            },
          ],
          submitted: true,
          resolved: true,
          answers: { "Pick one": "Alpha" },
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("已提交")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
  });

  it("shows dismissed copy when skipped without answers", () => {
    render(
      <QuestionCard
        question={{
          id: "10",
          toolCallId: "1:ask:question:0",
          questions: [
            {
              question: "Pick one",
              header: "Pick one",
              options: [{ label: "Alpha", description: "" }],
              multi_select: false,
            },
          ],
          submitted: true,
          resolved: true,
          answers: {},
        }}
        onRespond={vi.fn()}
        dismissed
      />,
    );

    expect(screen.getByText("已跳过，未作答")).toBeTruthy();
    expect(screen.getByText("未作答")).toBeTruthy();
  });
});
