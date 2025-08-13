export const HAIP_EVENT_TYPES = [
  "HAI",
  "PING",
  "PONG",
  "ERROR",
  "FLOW_UPDATE",
  "TRANSACTION_START",
  "TRANSACTION_END",
  "REPLAY_REQUEST",
  "MESSAGE_START",
  "MESSAGE_PART",
  "MESSAGE_END",
  "AUDIO_CHUNK",
  "INFO",
  "TOOL_LIST",
  "TOOL_SCHEMA",
  //"PAUSE_CHANNEL",
  //"RESUME_CHANNEL"
] as const;

export type HAIPEventType = (typeof HAIP_EVENT_TYPES)[number];
