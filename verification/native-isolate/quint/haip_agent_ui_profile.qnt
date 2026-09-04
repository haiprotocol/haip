module haip_agent_ui_profile {
  import domain.* from "./domain"

  pure def supportedProfile(s: str -> int): bool =
    s.get("profileRevision") == PROFILE_SUPPORTED
      and s.get("revisionAccepted") == ONE

  pure def exactEnvelopeBinding(s: str -> int): bool = all {
    s.get("bindingLocked") == ONE,
    s.get("envelopeDigest") != ZERO,
    s.get("bundleDigest") != ZERO,
    s.get("envelopeDigest") == s.get("boundEnvelopeDigest"),
    s.get("bundleDigest") == s.get("boundBundleDigest"),
    s.get("envelopeSource") == SOURCE_EXACT,
    s.get("bindingMutation") == ZERO,
  }

  pure def uiReady(s: str -> int): bool = all {
    s.get("host") == HOST_READY,
    s.get("view") == VIEW_INITIALIZED,
    s.get("uiInitialize") == ONE,
    s.get("uiInitialized") == ONE,
    exactEnvelopeBinding(s),
  }

  pure def uiWasInitialized(s: str -> int): bool = all {
    s.get("uiInitialize") == ONE,
    s.get("uiInitialized") == ONE,
    s.get("view") == VIEW_INITIALIZED or s.get("view") == VIEW_STOPPED,
    exactEnvelopeBinding(s),
  }

  // Native haip/ui.propose correlation: request-ID match, exact source/origin,
  // one-shot consumption. Proposal carries a schema-valid candidate only.
  pure def proposalCorrelationValid(s: str -> int): bool = all {
    s.get("proposalRequestId") != ZERO,
    s.get("proposalResponseId") == s.get("proposalRequestId"),
    s.get("proposalConsumedRequestId") == s.get("proposalRequestId"),
    s.get("proposalMethod") == METHOD_PROPOSE,
    s.get("proposalSource") == SOURCE_EXACT,
    s.get("resultOrigin") == ORIGIN_EXACT,
  }

  pure def teardownCorrelationValid(s: str -> int): bool = all {
    s.get("teardownRequestId") != ZERO,
    s.get("teardownResponseId") == s.get("teardownRequestId"),
    s.get("teardownConsumedRequestId") == s.get("teardownRequestId"),
  }

  pure def fixedDenyAll(s: str -> int): bool =
    s.get("policy") == POLICY_DENY_ALL
      and s.get("policyLocked") == ONE
      and s.get("policyMutation") == ZERO

  // Capability truthfulness: only the native propose capability exists.
  // Advertising methods beyond the fixed Agent UI profile is forbidden.
  pure def capabilityTruthful(s: str -> int): bool =
    s.get("extraProposalMethods") == ZERO

  // Normative happy path depends only on native isolate messaging state —
  // host/View, envelope, haip/ui.input|result snapshots, and haip/ui.propose.
  // The profile does not define tool names or delegated server tool surfaces.
  pure def nativeIsolateMessagingOnly(s: str -> int): bool = all {
    fixedDenyAll(s),
    capabilityTruthful(s),
    (s.get("host") != HOST_ABSENT).implies(supportedProfile(s)),
    (s.get("view") != VIEW_ABSENT).implies(exactEnvelopeBinding(s)),
    (s.get("proposalAccepted") == ONE).implies(uiWasInitialized(s)),
  }

  pure def appTransitionsCannotCreateAuthority(s: str -> int): bool =
    s.get("appCreatedAuthority") == ZERO

  pure def nativeProfileSafety(s: str -> int): bool = all {
    (s.get("revisionAccepted") == ONE).implies(
      s.get("profileRevision") == PROFILE_SUPPORTED),
    (s.get("bindingLocked") == ONE).implies(exactEnvelopeBinding(s)),
    (s.get("view") == VIEW_CREATED).implies(s.get("host") == HOST_READY),
    (s.get("uiInitialize") == ONE).implies(all {
      s.get("host") == HOST_READY
        or s.get("host") == HOST_STOPPING
        or s.get("host") == HOST_STOPPED
        or s.get("host") == HOST_CRASHED,
      s.get("view") == VIEW_CREATED
        or s.get("view") == VIEW_INITIALIZED
        or s.get("view") == VIEW_STOPPED,
      exactEnvelopeBinding(s),
    }),
    (s.get("uiInitialized") == ONE).implies(all {
      s.get("uiInitialize") == ONE,
      s.get("view") == VIEW_INITIALIZED or s.get("view") == VIEW_STOPPED,
    }),
    s.get("inputSnapshotCount") <= ONE,
    s.get("resultSnapshotCount") <= ONE,
    (s.get("inputSnapshotCount") == ONE).implies(uiWasInitialized(s)),
    (s.get("resultSnapshotCount") == ONE).implies(
      s.get("inputSnapshotCount") == ONE),
    (s.get("proposalRequestId") != ZERO).implies(
      s.get("resultSnapshotCount") == ONE),
    (s.get("proposalAccepted") == ONE).implies(all {
      uiWasInitialized(s),
      proposalCorrelationValid(s),
      s.get("inputSnapshotCount") == ONE,
      s.get("resultSnapshotCount") == ONE,
    }),
    (s.get("rejectedAttempt") == ONE).implies(
      s.get("proposalRejected") == ONE),
    (s.get("ignoredAfterAcceptance") == ONE).implies(all {
      s.get("proposalAccepted") == ONE,
      s.get("rejectedAttempt") == ONE,
    }),
    (s.get("rejectedMethod") == METHOD_FORBIDDEN).implies(all {
      s.get("forbiddenOperation") == ONE,
      s.get("proposalRejected") == ONE,
      s.get("rejectedAttempt") == ONE,
    }),
    (s.get("rejectedSource") == SOURCE_WRONG).implies(
      s.get("rejectedAttempt") == ONE),
    (s.get("rejectedOrigin") == ORIGIN_WRONG).implies(
      s.get("rejectedAttempt") == ONE),
    (s.get("proposalReplay") == ONE).implies(all {
      s.get("proposalRejected") == ONE,
      s.get("rejectedAttempt") == ONE,
    }),
    (s.get("host") == HOST_STOPPING).implies(all {
      s.get("teardownRequestId") != ZERO,
      uiWasInitialized(s),
    }),
    (s.get("teardownResponseId") != ZERO).implies(
      teardownCorrelationValid(s)),
    (s.get("host") == HOST_STOPPED).implies(all {
      s.get("controlledTeardown") == ONE,
      s.get("view") == VIEW_STOPPED,
      s.get("teardownRequestId") != ZERO,
      teardownCorrelationValid(s) or s.get("teardownRejected") == ONE,
    }),
    (s.get("teardownReplay") == ONE).implies(
      s.get("teardownRejected") == ONE),
    (s.get("host") == HOST_CRASHED).implies(s.get("crash") == ONE),
    ((s.get("host") == HOST_STOPPING
      or s.get("host") == HOST_STOPPED
      or s.get("host") == HOST_CRASHED)
      and s.get("humanConfirmation") == ZERO).implies(all {
        s.get("proposalAccepted") == ZERO,
        s.get("candidate") != C_PROPOSED,
        s.get("candidate") != C_FROZEN,
      }),
    (s.get("fallbackUsed") == ONE).implies(all {
      s.get("fallbackTrusted") == ONE,
      s.get("profileRevision") == PROFILE_UNSUPPORTED
        or s.get("host") == HOST_CRASHED,
    }),
    fixedDenyAll(s),
    capabilityTruthful(s),
    appTransitionsCannotCreateAuthority(s),
    nativeIsolateMessagingOnly(s),
  }
}
