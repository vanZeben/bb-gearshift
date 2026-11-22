/** Hint shown beside the Improve my rules button. */
export const IMPROVE_RULES_HINT = "Opens a new thread with a review prompt";

/** Draft seeded into the new-thread composer by the Improve my rules button. */
export function buildReviewPrompt(days: number): string {
  return `Evaluate my Gearshift routing for the last ${days} days with the gearshift skill: run "bb gearshift review --days ${days}", judge whether each gear fit the work, then propose rule changes and apply only the ones I approve.`;
}
