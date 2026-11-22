import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "./review-prompt";

describe("buildReviewPrompt", () => {
  it("uses the selected range in the sentence and the command", () => {
    const prompt = buildReviewPrompt(7);
    expect(prompt).toContain("for the last 7 days");
    expect(prompt).toContain('"bb gearshift review --days 7"');
  });

  it("asks for approval before applying changes", () => {
    expect(buildReviewPrompt(90)).toContain("apply only the ones I approve");
  });
});
