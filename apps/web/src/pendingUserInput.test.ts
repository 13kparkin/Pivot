import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  isFreeTextOptionLabel,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  shouldAutoAdvancePendingUserInputSelection,
  shouldRequestCustomAnswerForPendingUserInput,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    {
      label: "Orchestration-first",
      description: "Focus on orchestration first",
    },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    {
      label: "Server",
      description: "Server",
    },
    {
      label: "Web",
      description: "Web",
    },
  ],
  multiSelect: true,
} as const;

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to the selected option for single-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
      }),
    ).toBe("Orchestration-first");
  });

  it("returns all selected labels for multi-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(multiSelectQuestion, {
        selectedOptionLabels: ["Server", "Web"],
      }),
    ).toEqual(["Server", "Web"]);
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "doesn't matter",
      ),
    ).toEqual({
      customAnswer: "doesn't matter",
    });
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("toggles options for multi-select questions", () => {
    expect(togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Server")).toEqual(
      {
        customAnswer: "",
        selectedOptionLabels: ["Server"],
      },
    );

    expect(
      togglePendingUserInputOptionSelection(
        multiSelectQuestion,
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "Server",
      ),
    ).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Web"],
    });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          singleSelectQuestion,
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
            multiSelect: false,
          },
        ],
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("returns arrays for answered multi-select prompts", () => {
    expect(
      buildPendingUserInputAnswers([multiSelectQuestion], {
        areas: {
          selectedOptionLabels: ["Server", "Web"],
        },
      }),
    ).toEqual({
      areas: ["Server", "Web"],
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(buildPendingUserInputAnswers([singleSelectQuestion], {})).toBeNull();
  });
});

describe("pending user input question progress", () => {
  const questions = [
    singleSelectQuestion,
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
      multiSelect: false,
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
        compat: {
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabels: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });

  it("treats multi-select questions as answered when they have selected options", () => {
    expect(
      derivePendingUserInputProgress(
        [multiSelectQuestion],
        {
          areas: {
            selectedOptionLabels: ["Server", "Web"],
          },
        },
        0,
      ),
    ).toMatchObject({
      selectedOptionLabels: ["Server", "Web"],
      resolvedAnswer: ["Server", "Web"],
      canAdvance: true,
      isComplete: true,
    });
  });
});

const singleSelectWithOther = {
  id: "storage",
  header: "Storage",
  question: "Which storage backend?",
  options: [
    { label: "local", description: "local" },
    { label: "s3", description: "s3" },
    { label: "Other", description: "Other" },
  ],
  multiSelect: false,
} as const;

describe("isFreeTextOptionLabel", () => {
  it("matches the exact label Other", () => {
    expect(isFreeTextOptionLabel("Other")).toBe(true);
  });

  it("matches omp's TUI 'Other (type your own)' form, case-insensitively", () => {
    expect(isFreeTextOptionLabel("Other (type your own)")).toBe(true);
    expect(isFreeTextOptionLabel("other (type your own)")).toBe(true);
  });

  it("does not match ordinary option labels", () => {
    expect(isFreeTextOptionLabel("local")).toBe(false);
    expect(isFreeTextOptionLabel("s3")).toBe(false);
    expect(isFreeTextOptionLabel("Others")).toBe(false);
    expect(isFreeTextOptionLabel("")).toBe(false);
  });
});

describe("shouldAutoAdvancePendingUserInputSelection", () => {
  it("auto-advances single-select ordinary options", () => {
    expect(shouldAutoAdvancePendingUserInputSelection(singleSelectWithOther, "s3")).toBe(true);
  });

  it("never auto-advances a free-text option (clicking Other must not submit the literal label)", () => {
    expect(shouldAutoAdvancePendingUserInputSelection(singleSelectWithOther, "Other")).toBe(false);
    expect(
      shouldAutoAdvancePendingUserInputSelection(singleSelectWithOther, "Other (type your own)"),
    ).toBe(false);
  });

  it("never auto-advances multi-select questions", () => {
    expect(shouldAutoAdvancePendingUserInputSelection(multiSelectQuestion, "Server")).toBe(false);
  });
});

describe("shouldRequestCustomAnswerForPendingUserInput", () => {
  it("requests a custom answer for a single-select free-text option", () => {
    expect(shouldRequestCustomAnswerForPendingUserInput(singleSelectWithOther, "Other", [])).toBe(
      true,
    );
  });

  it("requests a custom answer when adding a free-text option to a multi-select question", () => {
    expect(
      shouldRequestCustomAnswerForPendingUserInput(multiSelectQuestion, "Other", ["Server"]),
    ).toBe(true);
  });

  it("does not request a custom answer when removing a free-text option from a multi-select question", () => {
    expect(
      shouldRequestCustomAnswerForPendingUserInput(multiSelectQuestion, "Other", [
        "Server",
        "Other",
      ]),
    ).toBe(false);
  });

  it("does not request a custom answer for ordinary options", () => {
    expect(shouldRequestCustomAnswerForPendingUserInput(singleSelectWithOther, "s3", [])).toBe(
      false,
    );
    expect(shouldRequestCustomAnswerForPendingUserInput(multiSelectQuestion, "Server", [])).toBe(
      false,
    );
  });
});
