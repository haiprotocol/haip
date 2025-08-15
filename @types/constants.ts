export const HAIP_EVENT_TYPES = [
  "HAI",
  "PING",
  "PONG",
  "ERROR",
  "FLOW_UPDATE",
  "TRANSACTION_START",
  "TRANSACTION_END",
  "TRANSACTION_JOIN",
  "REPLAY_REQUEST",
  "MESSAGE_UPDATE",
  "MESSAGE",
  "AUDIO",
  "INFO",
  "TOOL_LIST",
  "TOOL_SCHEMA",
  //"PAUSE_CHANNEL",
  //"RESUME_CHANNEL"
] as const;

export type HAIPEventType = (typeof HAIP_EVENT_TYPES)[number];
