import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "./review-prompt";

describe("buildReviewPrompt", () => {
  it("uses the selected range in the sentence and the command", () => {
    const prompt = buildReviewPrompt(7);
    expect(prompt).toContain("for the last 7 days");
    expect(prompt).toContain('"bb gearshift review --days 7"');
  });

  it("asks for approval before applying changes", () => {
    expect(buildReviewPrompt(90)).toContain("Apply only the changes I approve");
  });

  it("offers replay to test a proposed change first", () => {
    const prompt = buildReviewPrompt(30);
    expect(prompt).toContain('"bb gearshift replay --days 30 --set <path>=<value>"');
    expect(prompt.indexOf("replay")).toBeLessThan(prompt.indexOf("Apply only"));
  });
});
