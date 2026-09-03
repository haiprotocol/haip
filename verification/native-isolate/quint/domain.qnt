module domain {
  // The executable model uses finite integer encodings so exhaustive checking
  // stays useful. Named constants make protocol distinctions visible.
  pure val ZERO = 0
  pure val ONE = 1
  pure val TWO = 2
  pure val THREE = 3
  pure val FOUR = 4
  pure val FIVE = 5

  // Candidate: none, proposed, frozen, dismissed, confirmed.
  pure val C_NONE = ZERO
  pure val C_PROPOSED = ONE
  pure val C_FROZEN = TWO
  pure val C_DISMISSED = THREE
  pure val C_CONFIRMED = FOUR

  // Purpose is deliberately not collapsed into a generic approval.
  pure val PURPOSE_NONE = ZERO
  pure val PURPOSE_REVIEW = ONE
  pure val PURPOSE_AUTHORISE_EXECUTION = TWO

  // Native host: absent, starting, ready, stopping, stopped, crashed.
  pure val HOST_ABSENT = ZERO
  pure val HOST_STARTING = ONE
  pure val HOST_READY = TWO
  pure val HOST_STOPPING = THREE
  pure val HOST_STOPPED = FOUR
  pure val HOST_CRASHED = FIVE

  // Native View: absent, created, initialized, stopped.
  pure val VIEW_ABSENT = ZERO
  pure val VIEW_CREATED = ONE
  pure val VIEW_INITIALIZED = TWO
  pure val VIEW_STOPPED = THREE

  // Effects are created only by the HAIP execution lifecycle. Cancellation
  // racing dispatch makes the external effect uncertain, never safely absent.
  pure val EFFECT_NONE = ZERO
  pure val EFFECT_CERTAIN = ONE
  pure val EFFECT_UNCERTAIN = TWO

  // Finite native isolate messaging vocabulary.
  // METHOD_PROPOSE is the sole View→Host proposal method (haip/ui.propose).
  pure val PROFILE_NONE = ZERO
  pure val PROFILE_SUPPORTED = ONE
  pure val PROFILE_UNSUPPORTED = TWO
  pure val METHOD_NONE = ZERO
  pure val METHOD_PROPOSE = ONE
  pure val METHOD_FORBIDDEN = TWO
  pure val SOURCE_NONE = ZERO
  pure val SOURCE_EXACT = ONE
  pure val SOURCE_WRONG = TWO
  pure val ORIGIN_NONE = ZERO
  pure val ORIGIN_EXACT = ONE
  pure val ORIGIN_WRONG = TWO
  pure val POLICY_DENY_ALL = ONE

  pure def bit(n: int): bool = n == ZERO or n == ONE
  pure def boundedCount(n: int): bool = n >= ZERO and n <= TWO
}
