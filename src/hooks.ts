// Late-bound callbacks so tools and routines can start tasks without importing the Telegram app (avoids import cycles).
export const hooks = {
  startTask: (_botId: string, _prompt: string, _label?: string): void => {},
  /** One bot hands part of a job to another and gets its result back (set in core.ts). */
  handOff: async (_a: { fromId: string; to: string; task: string; threadId: string }): Promise<string> => "",
  /** A bot makes a helper bot for a job (set in core.ts). Returns its name. */
  createHelper: (_a: { byId: string; name: string; job: string; threadId: string }): string => "",
  /** A new email arrived at the agent's address (set in core.ts). */
  emailArrived: (_m: { from: string; to: string; subject: string; date: string; text: string; messageId?: string }): void => {},
};
