module composition {
  import domain.* from "./domain"
  import haip_spec.* from "./haip_spec"
  import haip_agent_ui_profile.* from "./haip_agent_ui_profile"

  // A finite map keeps native UI/profile and HAIP authority ordering explicit.
  var st: str -> int

  action init = st' = Map(
    "variant" -> ZERO,
    "candidate" -> C_NONE,
    "appProposal" -> ZERO,
    "candidateDigest" -> ZERO,
    "displayedDigest" -> ZERO,
    "authenticated" -> ZERO,
    "eligible" -> ZERO,
    "purpose" -> PURPOSE_NONE,
    "reviewRecorded" -> ZERO,
    "humanConfirmation" -> ZERO,
    "authorized" -> ZERO,
    "handle" -> ZERO,
    "signature" -> ZERO,
    "trusted" -> ZERO,
    "grantIssued" -> ZERO,
    "grantExpired" -> ZERO,
    "grantRevoked" -> ZERO,
    "grantConsumed" -> ZERO,
    "occurrenceId" -> ZERO,
    "claimCount" -> ZERO,
    "admissions" -> ZERO,
    "dispatch" -> ZERO,
    "outcome" -> ZERO,
    "effect" -> EFFECT_NONE,
    "haipCancelled" -> ZERO,
    "dispatchAfterCancel" -> ZERO,
    "profileRevision" -> PROFILE_NONE,
    "revisionAccepted" -> ZERO,
    "envelopeDigest" -> ZERO,
    "bundleDigest" -> ZERO,
    "boundEnvelopeDigest" -> ZERO,
    "boundBundleDigest" -> ZERO,
    "envelopeSource" -> SOURCE_NONE,
    "bindingLocked" -> ZERO,
    "bindingMutation" -> ZERO,
    "host" -> HOST_ABSENT,
    "view" -> VIEW_ABSENT,
    "uiInitialize" -> ZERO,
    "uiInitialized" -> ZERO,
    "inputSnapshotCount" -> ZERO,
    "resultSnapshotCount" -> ZERO,
    "duplicateSnapshot" -> ZERO,
    "proposalRequestId" -> ZERO,
    "proposalResponseId" -> ZERO,
    "proposalConsumedRequestId" -> ZERO,
    "proposalReplay" -> ZERO,
    "proposalMethod" -> METHOD_NONE,
    "proposalSource" -> SOURCE_NONE,
    "proposalAccepted" -> ZERO,
    "proposalRejected" -> ZERO,
    "resultOrigin" -> ORIGIN_NONE,
    "forbiddenOperation" -> ZERO,
    "policy" -> POLICY_DENY_ALL,
    "policyLocked" -> ONE,
    "policyMutation" -> ZERO,
    "fallbackTrusted" -> ZERO,
    "fallbackUsed" -> ZERO,
    "controlledTeardown" -> ZERO,
    "crash" -> ZERO,
    "appTransition" -> ZERO,
    "appCreatedAuthority" -> ZERO,
    "proposalProxy" -> ZERO,
    "proposalFiltered" -> ZERO,
    "extraProposalMethods" -> ZERO,
    "uncontrolledTeardown" -> ZERO,
  )

  action selectImplementation = all {
    st.get("variant") == ZERO,
    st' = st.set("variant", ONE),
  }

  action negotiateSupportedProfile = all {
    st.get("profileRevision") == PROFILE_NONE,
    st' = st
      .set("profileRevision", PROFILE_SUPPORTED)
      .set("revisionAccepted", ONE)
      .set("appTransition", ONE),
  }

  action rejectUnsupportedProfile = all {
    st.get("profileRevision") == PROFILE_NONE,
    st' = st
      .set("profileRevision", PROFILE_UNSUPPORTED)
      .set("proposalRejected", ONE)
      .set("appTransition", ONE),
  }

  action bindValidEnvelope = all {
    supportedProfile(st),
    st.get("bindingLocked") == ZERO,
    st' = st
      .set("envelopeDigest", ONE)
      .set("bundleDigest", ONE)
      .set("boundEnvelopeDigest", ONE)
      .set("boundBundleDigest", ONE)
      .set("envelopeSource", SOURCE_EXACT)
      .set("bindingLocked", ONE)
      .set("appTransition", ONE),
  }

  action rejectDigestMismatch = all {
    supportedProfile(st),
    st.get("bindingLocked") == ZERO,
    st' = st
      .set("envelopeDigest", ONE)
      .set("bundleDigest", TWO)
      .set("proposalRejected", ONE)
      .set("appTransition", ONE),
  }

  action startHost = all {
    supportedProfile(st),
    exactEnvelopeBinding(st),
    st.get("host") == HOST_ABSENT,
    st' = st.set("host", HOST_STARTING).set("appTransition", ONE),
  }

  action readyHost = all {
    st.get("host") == HOST_STARTING,
    st' = st.set("host", HOST_READY).set("appTransition", ONE),
  }

  action createView = all {
    st.get("host") == HOST_READY,
    st.get("view") == VIEW_ABSENT,
    exactEnvelopeBinding(st),
    st' = st.set("view", VIEW_CREATED).set("appTransition", ONE),
  }

  // Native haip/ui.initialize request.
  action initializeUi = all {
    st.get("host") == HOST_READY,
    st.get("view") == VIEW_CREATED,
    exactEnvelopeBinding(st),
    st.get("uiInitialize") == ZERO,
    st' = st.set("uiInitialize", ONE).set("appTransition", ONE),
  }

  // Native haip/ui.initialized notification.
  action notifyUiInitialized = all {
    st.get("uiInitialize") == ONE,
    st.get("uiInitialized") == ZERO,
    st' = st
      .set("uiInitialized", ONE)
      .set("view", VIEW_INITIALIZED)
      .set("appTransition", ONE),
  }

  action rejectPreInitInput = all {
    st.get("uiInitialized") == ZERO,
    st.get("inputSnapshotCount") == ZERO,
    st' = st
      .set("proposalRejected", ONE)
      .set("appTransition", ONE),
  }

  // Native haip/ui.input — one-shot immutable input snapshot.
  action captureInputSnapshot = all {
    uiReady(st),
    st.get("inputSnapshotCount") == ZERO,
    st' = st.set("inputSnapshotCount", ONE).set("appTransition", ONE),
  }

  action rejectDuplicateInputSnapshot = all {
    st.get("inputSnapshotCount") == ONE,
    st' = st
      .set("duplicateSnapshot", ONE)
      .set("proposalRejected", ONE)
      .set("appTransition", ONE),
  }

  // Native haip/ui.propose request with source and request-ID correlation.
  action requestPropose = all {
    uiReady(st),
    st.get("inputSnapshotCount") == ONE,
    st.get("proposalRequestId") == ZERO,
    st' = st
      .set("proposalRequestId", ONE)
      .set("proposalMethod", METHOD_PROPOSE)
      .set("proposalSource", SOURCE_EXACT)
      .set("appTransition", ONE),
  }

  // Correlated haip/ui.propose success plus one-shot haip/ui.result snapshot.
  action returnCorrelatedProposal = all {
    st.get("proposalRequestId") == ONE,
    st.get("proposalMethod") == METHOD_PROPOSE,
    st.get("proposalSource") == SOURCE_EXACT,
    st.get("resultSnapshotCount") == ZERO,
    st' = st
      .set("proposalResponseId", ONE)
      .set("proposalConsumedRequestId", ONE)
      .set("resultOrigin", ORIGIN_EXACT)
      .set("resultSnapshotCount", ONE)
      .set("proposalAccepted", ONE)
      .set("appTransition", ONE),
  }

  // Native haip/ui.propose failure (validation/schema) without acceptance.
  action rejectPropose = all {
    st.get("proposalRequestId") == ONE,
    st.get("proposalMethod") == METHOD_PROPOSE,
    st.get("proposalAccepted") == ZERO,
    st.get("proposalConsumedRequestId") == ZERO,
    st' = st
      .set("proposalRejected", ONE)
      .set("proposalAccepted", ZERO)
      .set("appTransition", ONE),
  }

  action rejectProposalReplay = all {
    st.get("proposalConsumedRequestId") != ZERO,
    st' = st
      .set("proposalReplay", ONE)
      .set("proposalAccepted", ZERO)
      .set("proposalRejected", ONE)
      .set("appTransition", ONE),
  }

  action rejectDuplicateResultSnapshot = all {
    st.get("resultSnapshotCount") == ONE,
    st' = st
      .set("duplicateSnapshot", ONE)
      .set("proposalReplay", ONE)
      .set("proposalAccepted", ZERO)
      .set("proposalRejected", ONE)
      .set("appTransition", ONE),
  }

  action rejectForbiddenMethod = all {
    st.get("uiInitialized") == ONE,
    st.get("proposalMethod") == METHOD_NONE,
    st' = st
      .set("proposalMethod", METHOD_FORBIDDEN)
      .set("forbiddenOperation", ONE)
      .set("proposalRejected", ONE)
      .set("appTransition", ONE),
  }

  action rejectWrongSource = all {
    st.get("uiInitialized") == ONE,
    st' = st
      .set("proposalSource", SOURCE_WRONG)
      .set("proposalRejected", ONE)
      .set("appTransition", ONE),
  }

  action rejectWrongOrigin = all {
    st.get("proposalRequestId") != ZERO,
    st' = st
      .set("proposalResponseId", st.get("proposalRequestId"))
      .set("resultOrigin", ORIGIN_WRONG)
      .set("proposalRejected", ONE)
      .set("appTransition", ONE),
  }

  action activateTrustedFallback = all {
    st.get("fallbackUsed") == ZERO,
    st.get("profileRevision") == PROFILE_UNSUPPORTED
      or st.get("host") == HOST_CRASHED,
    st' = st
      .set("fallbackTrusted", ONE)
      .set("fallbackUsed", ONE)
      .set("appTransition", ONE),
  }

  // Native haip/ui.teardown request (controlled).
  action beginControlledTeardown = all {
    st.get("host") == HOST_READY,
    st' = st
      .set("host", HOST_STOPPING)
      .set("view", VIEW_STOPPED)
      .set("appTransition", ONE),
  }

  // Native haip/ui.teardown completion.
  action finishControlledTeardown = all {
    st.get("host") == HOST_STOPPING,
    st' = st
      .set("host", HOST_STOPPED)
      .set("controlledTeardown", ONE)
      .set("appTransition", ONE),
  }

  action crashHost = all {
    st.get("host") == HOST_STARTING or st.get("host") == HOST_READY,
    st' = st
      .set("host", HOST_CRASHED)
      .set("view", VIEW_STOPPED)
      .set("crash", ONE)
      .set("appTransition", ONE),
  }

  action proposeCandidate = all {
    st.get("proposalAccepted") == ONE,
    st.get("candidate") == C_NONE,
    st' = st
      .set("candidate", C_PROPOSED)
      .set("appProposal", ONE)
      .set("candidateDigest", ONE)
      .set("purpose", PURPOSE_REVIEW)
      .set("appTransition", ZERO),
  }

  action proposeExecutionCandidate = all {
    st.get("proposalAccepted") == ONE,
    st.get("candidate") == C_NONE,
    st' = st
      .set("candidate", C_PROPOSED)
      .set("appProposal", ONE)
      .set("candidateDigest", ONE)
      .set("purpose", PURPOSE_AUTHORISE_EXECUTION)
      .set("appTransition", ZERO),
  }

  action freezeCandidate = all {
    st.get("candidate") == C_PROPOSED,
    st' = st
      .set("candidate", C_FROZEN)
      .set("displayedDigest", ONE)
      .set("appTransition", ZERO),
  }

  action freezeWrongDigest = all {
    st.get("candidate") == C_PROPOSED,
    st' = st
      .set("candidate", C_FROZEN)
      .set("displayedDigest", TWO)
      .set("appTransition", ZERO),
  }

  action dismissCandidate = all {
    st.get("candidate") == C_PROPOSED or st.get("candidate") == C_FROZEN,
    st' = st.set("candidate", C_DISMISSED).set("appTransition", ZERO),
  }

  action authenticateEligibleHuman = all {
    st.get("candidate") == C_FROZEN,
    st.get("authenticated") == ZERO,
    st' = st
      .set("authenticated", ONE)
      .set("eligible", ONE)
      .set("appTransition", ZERO),
  }

  action authenticateIneligibleHuman = all {
    st.get("candidate") == C_FROZEN,
    st.get("authenticated") == ZERO,
    st' = st.set("authenticated", ONE).set("appTransition", ZERO),
  }

  action observeHandleAndSignature = all {
    st.get("handle") == ZERO,
    st' = st
      .set("handle", ONE)
      .set("signature", ONE)
      .set("appTransition", ZERO),
  }

  action confirmCandidate = all {
    validHumanConfirmation(st),
    st' = st
      .set("candidate", C_CONFIRMED)
      .set("reviewRecorded", ONE)
      .set("humanConfirmation", ONE)
      .set("appTransition", ZERO),
  }

  action establishTrust = all {
    st.get("humanConfirmation") == ONE,
    st.get("trusted") == ZERO,
    st' = st.set("trusted", ONE).set("appTransition", ZERO),
  }

  action authorizeExecution = all {
    canAuthorizeExecution(st),
    st.get("authorized") == ZERO,
    st' = st.set("authorized", ONE).set("appTransition", ZERO),
  }

  action issueGrant = all {
    st.get("authorized") == ONE,
    st.get("grantIssued") == ZERO,
    st' = st.set("grantIssued", ONE).set("appTransition", ZERO),
  }

  action expireGrant = all {
    st.get("grantIssued") == ONE,
    st.get("grantExpired") == ZERO,
    st.get("grantConsumed") == ZERO,
    st' = st.set("grantExpired", ONE).set("appTransition", ZERO),
  }

  action revokeGrant = all {
    st.get("grantIssued") == ONE,
    st.get("grantRevoked") == ZERO,
    st.get("grantConsumed") == ZERO,
    st' = st.set("grantRevoked", ONE).set("appTransition", ZERO),
  }

  action bindClaim = all {
    canClaim(st),
    st' = st
      .set("occurrenceId", ONE)
      .set("claimCount", ONE)
      .set("appTransition", ZERO),
  }

  action admit = all {
    canAdmit(st),
    grantUsable(st),
    st.get("proposalAccepted") == ONE,
    st' = st
      .set("admissions", ONE)
      .set("grantConsumed", ONE)
      .set("appTransition", ZERO),
  }

  action dispatch = all {
    canDispatch(st),
    st.get("haipCancelled") == ZERO,
    st' = st.set("dispatch", ONE).set("appTransition", ZERO),
  }

  action recordOutcome = all {
    canRecordOutcome(st),
    st.get("haipCancelled") == ZERO,
    st' = st
      .set("outcome", ONE)
      .set("effect", EFFECT_CERTAIN)
      .set("appTransition", ZERO),
  }

  action cancelNativeAuthorization = all {
    st.get("admissions") == ONE,
    st.get("dispatch") == ZERO,
    st.get("haipCancelled") == ZERO,
    st' = st.set("haipCancelled", ONE).set("appTransition", ZERO),
  }

  action dispatchAfterCancellation = all {
    canDispatch(st),
    st.get("haipCancelled") == ONE,
    st' = st
      .set("dispatch", ONE)
      .set("dispatchAfterCancel", ONE)
      .set("appTransition", ZERO),
  }

  action recordUncertainEffect = all {
    st.get("dispatchAfterCancel") == ONE,
    st.get("effect") == EFFECT_NONE,
    st' = st
      .set("effect", EFFECT_UNCERTAIN)
      .set("outcome", ONE)
      .set("appTransition", ZERO),
  }

  // Deliberate implementation-only discrepancy observations.
  action outcomeWithoutAdmission = all {
    st.get("variant") == ONE,
    st.get("outcome") == ZERO,
    st' = st.set("outcome", ONE),
  }

  action duplicateAdmission = all {
    st.get("variant") == ONE,
    st.get("admissions") == ONE,
    st' = st.set("admissions", TWO),
  }

  action filterProposal = all {
    st.get("variant") == ONE,
    st.get("proposalProxy") == ZERO,
    st' = st.set("proposalProxy", ONE).set("proposalFiltered", ONE),
  }

  // Implementation discrepancy: advertise methods beyond haip/ui.propose
  // (capability-untruthful advertisement beyond the fixed profile).
  action advertiseExtraProposalMethods = all {
    st.get("variant") == ONE,
    st.get("extraProposalMethods") == ZERO,
    st' = st.set("extraProposalMethods", ONE),
  }

  action stopHostWithoutControl = all {
    st.get("variant") == ONE,
    st.get("host") == HOST_READY,
    st' = st
      .set("host", HOST_STOPPED)
      .set("view", VIEW_STOPPED)
      .set("uncontrolledTeardown", ONE),
  }


  action mutateLockedBinding = all {
    st.get("variant") == ONE,
    st.get("bindingLocked") == ONE,
    st' = st
      .set("bundleDigest", TWO)
      .set("bindingMutation", ONE),
  }

  action mutateFixedPolicy = all {
    st.get("variant") == ONE,
    st' = st.set("policy", TWO).set("policyMutation", ONE),
  }

  action step = any {
    negotiateSupportedProfile,
    rejectUnsupportedProfile,
    bindValidEnvelope,
    rejectDigestMismatch,
    startHost,
    readyHost,
    createView,
    initializeUi,
    notifyUiInitialized,
    rejectPreInitInput,
    captureInputSnapshot,
    rejectDuplicateInputSnapshot,
    requestPropose,
    returnCorrelatedProposal,
    rejectPropose,
    rejectProposalReplay,
    rejectDuplicateResultSnapshot,
    rejectForbiddenMethod,
    rejectWrongSource,
    rejectWrongOrigin,
    activateTrustedFallback,
    beginControlledTeardown,
    finishControlledTeardown,
    crashHost,
    proposeCandidate,
    proposeExecutionCandidate,
    freezeCandidate,
    freezeWrongDigest,
    dismissCandidate,
    authenticateEligibleHuman,
    authenticateIneligibleHuman,
    observeHandleAndSignature,
    confirmCandidate,
    establishTrust,
    authorizeExecution,
    issueGrant,
    expireGrant,
    revokeGrant,
    bindClaim,
    admit,
    cancelNativeAuthorization,
    dispatch,
    recordOutcome,
    dispatchAfterCancellation,
    recordUncertainEffect,
  }

  action implementationStep = any {
    step,
    selectImplementation,
    outcomeWithoutAdmission,
    duplicateAdmission,
    filterProposal,
    advertiseExtraProposalMethods,
    stopHostWithoutControl,
    mutateLockedBinding,
    mutateFixedPolicy,
  }
}
