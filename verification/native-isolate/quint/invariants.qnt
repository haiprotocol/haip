module invariants {
  import domain.* from "./domain"
  import composition.* from "./composition"
  import haip_spec.* from "./haip_spec"
  import haip_agent_ui_profile.* from "./haip_agent_ui_profile"

  val candidateAndAuthority = normativeHaip(st)
  val nativeUiProfile = nativeProfileSafety(st)

  // Normative HAIP safety: approval/authority/effect spine + native Agent UI.
  val haipSafety = all {
    candidateAndAuthority,
    nativeUiProfile,
  }

  val nativeIsolateMessagingOnlyRequired = nativeIsolateMessagingOnly(st)
  val capabilityTruthfulness = capabilityTruthful(st)

  val boundedState = all {
    bit(st.get("variant")),
    st.get("candidate") >= C_NONE and st.get("candidate") <= C_CONFIRMED,
    bit(st.get("appProposal")),
    st.get("candidateDigest") >= ZERO and st.get("candidateDigest") <= TWO,
    st.get("displayedDigest") >= ZERO and st.get("displayedDigest") <= TWO,
    bit(st.get("authenticated")),
    bit(st.get("eligible")),
    st.get("purpose") >= PURPOSE_NONE
      and st.get("purpose") <= PURPOSE_AUTHORISE_EXECUTION,
    bit(st.get("reviewRecorded")),
    bit(st.get("humanConfirmation")),
    bit(st.get("authorized")),
    bit(st.get("handle")),
    bit(st.get("signature")),
    bit(st.get("trusted")),
    bit(st.get("grantIssued")),
    bit(st.get("grantExpired")),
    bit(st.get("grantRevoked")),
    bit(st.get("grantConsumed")),
    st.get("occurrenceId") >= ZERO and st.get("occurrenceId") <= TWO,
    boundedCount(st.get("claimCount")),
    boundedCount(st.get("admissions")),
    bit(st.get("dispatch")),
    bit(st.get("outcome")),
    st.get("effect") >= EFFECT_NONE and st.get("effect") <= EFFECT_UNCERTAIN,
    bit(st.get("haipCancelled")),
    bit(st.get("dispatchAfterCancel")),
    st.get("profileRevision") >= PROFILE_NONE
      and st.get("profileRevision") <= PROFILE_UNSUPPORTED,
    bit(st.get("revisionAccepted")),
    st.get("envelopeDigest") >= ZERO and st.get("envelopeDigest") <= TWO,
    st.get("bundleDigest") >= ZERO and st.get("bundleDigest") <= TWO,
    st.get("boundEnvelopeDigest") >= ZERO
      and st.get("boundEnvelopeDigest") <= TWO,
    st.get("boundBundleDigest") >= ZERO
      and st.get("boundBundleDigest") <= TWO,
    st.get("envelopeSource") >= SOURCE_NONE
      and st.get("envelopeSource") <= SOURCE_WRONG,
    bit(st.get("bindingLocked")),
    bit(st.get("bindingMutation")),
    st.get("host") >= HOST_ABSENT and st.get("host") <= HOST_CRASHED,
    st.get("view") >= VIEW_ABSENT and st.get("view") <= VIEW_STOPPED,
    bit(st.get("uiInitialize")),
    bit(st.get("uiInitialized")),
    boundedCount(st.get("inputSnapshotCount")),
    boundedCount(st.get("resultSnapshotCount")),
    bit(st.get("duplicateSnapshot")),
    st.get("proposalRequestId") >= ZERO
      and st.get("proposalRequestId") <= TWO,
    st.get("proposalResponseId") >= ZERO
      and st.get("proposalResponseId") <= TWO,
    st.get("proposalConsumedRequestId") >= ZERO
      and st.get("proposalConsumedRequestId") <= TWO,
    bit(st.get("proposalReplay")),
    st.get("proposalMethod") >= METHOD_NONE
      and st.get("proposalMethod") <= METHOD_FORBIDDEN,
    st.get("proposalSource") >= SOURCE_NONE
      and st.get("proposalSource") <= SOURCE_WRONG,
    bit(st.get("proposalAccepted")),
    bit(st.get("proposalRejected")),
    bit(st.get("rejectedAttempt")),
    bit(st.get("ignoredAfterAcceptance")),
    st.get("rejectedMethod") >= METHOD_NONE
      and st.get("rejectedMethod") <= METHOD_FORBIDDEN,
    st.get("rejectedSource") >= SOURCE_NONE
      and st.get("rejectedSource") <= SOURCE_WRONG,
    st.get("rejectedOrigin") >= ORIGIN_NONE
      and st.get("rejectedOrigin") <= ORIGIN_WRONG,
    st.get("resultOrigin") >= ORIGIN_NONE
      and st.get("resultOrigin") <= ORIGIN_WRONG,
    bit(st.get("forbiddenOperation")),
    st.get("policy") >= POLICY_DENY_ALL and st.get("policy") <= TWO,
    bit(st.get("policyLocked")),
    bit(st.get("policyMutation")),
    bit(st.get("fallbackTrusted")),
    bit(st.get("fallbackUsed")),
    bit(st.get("controlledTeardown")),
    st.get("teardownRequestId") >= ZERO
      and st.get("teardownRequestId") <= TWO,
    st.get("teardownResponseId") >= ZERO
      and st.get("teardownResponseId") <= TWO,
    st.get("teardownConsumedRequestId") >= ZERO
      and st.get("teardownConsumedRequestId") <= TWO,
    bit(st.get("teardownRejected")),
    bit(st.get("teardownReplay")),
    bit(st.get("crash")),
    bit(st.get("appTransition")),
    bit(st.get("appCreatedAuthority")),
    bit(st.get("proposalProxy")),
    bit(st.get("proposalFiltered")),
    bit(st.get("extraProposalMethods")),
    bit(st.get("uncontrolledTeardown")),
  }
}
