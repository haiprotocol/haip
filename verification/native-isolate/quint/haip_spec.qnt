module haip_spec {
  import domain.* from "./domain"

  pure def candidateMatchesDisplay(s: str -> int): bool =
    s.get("candidateDigest") != ZERO
      and s.get("candidateDigest") == s.get("displayedDigest")

  pure def validHumanConfirmation(s: str -> int): bool = all {
    s.get("candidate") == C_FROZEN,
    candidateMatchesDisplay(s),
    s.get("authenticated") == ONE,
    s.get("eligible") == ONE,
    s.get("purpose") != PURPOSE_NONE,
    s.get("humanConfirmation") == ZERO,
  }

  pure def grantUsable(s: str -> int): bool = all {
    s.get("grantIssued") == ONE,
    s.get("grantExpired") == ZERO,
    s.get("grantRevoked") == ZERO,
    s.get("grantConsumed") == ZERO,
  }

  pure def canAuthorizeExecution(s: str -> int): bool = all {
    s.get("candidate") == C_CONFIRMED,
    s.get("humanConfirmation") == ONE,
    s.get("authenticated") == ONE,
    s.get("eligible") == ONE,
    s.get("purpose") == PURPOSE_AUTHORISE_EXECUTION,
  }

  pure def canClaim(s: str -> int): bool = all {
    s.get("authorized") == ONE,
    grantUsable(s),
    s.get("claimCount") == ZERO,
  }

  pure def canAdmit(s: str -> int): bool =
    s.get("claimCount") == ONE
      and s.get("occurrenceId") != ZERO
      and s.get("admissions") == ZERO

  pure def canDispatch(s: str -> int): bool =
    s.get("admissions") == ONE
      and s.get("authorized") == ONE
      and s.get("proposalAccepted") == ONE
      and s.get("dispatch") == ZERO

  pure def canRecordOutcome(s: str -> int): bool =
    s.get("dispatch") == ONE and s.get("outcome") == ZERO

  // Handles and signatures are evidence, never roots of trust.
  pure def trustGrounded(s: str -> int): bool =
    (s.get("trusted") == ONE).implies(all {
      s.get("authenticated") == ONE,
      s.get("eligible") == ONE,
      s.get("humanConfirmation") == ONE,
    })

  pure def normativeHaip(s: str -> int): bool = all {
    (s.get("candidate") == C_CONFIRMED).implies(all {
      s.get("appProposal") == ONE,
      candidateMatchesDisplay(s),
      s.get("humanConfirmation") == ONE,
      s.get("authenticated") == ONE,
      s.get("eligible") == ONE,
    }),
    (s.get("humanConfirmation") == ONE).implies(
      s.get("candidate") == C_CONFIRMED
        and s.get("reviewRecorded") == ONE
        and s.get("purpose") != PURPOSE_NONE),
    (s.get("purpose") == PURPOSE_REVIEW).implies(
      s.get("authorized") == ZERO),
    (s.get("authorized") == ONE).implies(all {
      s.get("humanConfirmation") == ONE,
      s.get("purpose") == PURPOSE_AUTHORISE_EXECUTION,
    }),
    (s.get("grantExpired") == ONE).implies(s.get("grantIssued") == ONE),
    (s.get("grantRevoked") == ONE).implies(s.get("grantIssued") == ONE),
    (s.get("grantConsumed") == ONE).implies(all {
      s.get("grantIssued") == ONE,
      s.get("admissions") == ONE,
    }),
    (s.get("claimCount") == ONE).implies(all {
      s.get("occurrenceId") != ZERO,
      s.get("grantIssued") == ONE,
    }),
    (s.get("admissions") > ZERO).implies(s.get("claimCount") == ONE),
    (s.get("dispatch") == ONE).implies(s.get("admissions") == ONE),
    (s.get("outcome") == ONE).implies(s.get("admissions") == ONE),
    (s.get("effect") != EFFECT_NONE).implies(s.get("admissions") == ONE),
    (s.get("dispatchAfterCancel") == ONE).implies(all {
      s.get("haipCancelled") == ONE,
      s.get("dispatch") == ONE,
    }),
    (s.get("effect") == EFFECT_UNCERTAIN).implies(all {
      s.get("haipCancelled") == ONE,
      s.get("dispatchAfterCancel") == ONE,
    }),
    (s.get("appProposal") == ONE).implies(
      s.get("candidate") != C_NONE),
    s.get("claimCount") <= ONE,
    s.get("admissions") <= ONE,
    trustGrounded(s),
  }
}
