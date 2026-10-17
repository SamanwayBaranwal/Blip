// Late-bound callbacks so tools and routines can start tasks without importing the Telegram app (avoids import cycles).
export const hooks = {
  startTask: (_botId: string, _prompt: string, _label?: string): void => {},
};
