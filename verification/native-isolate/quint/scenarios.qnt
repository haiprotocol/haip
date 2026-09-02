module scenarios {
  import domain.* from "./domain"
  import composition.* from "./composition"
  import haip_spec.* from "./haip_spec"
  import haip_agent_ui_profile.* from "./haip_agent_ui_profile"
  import invariants.* from "./invariants"
  import temporal_properties.* from "./temporal"
  import discrepancies.* from "./discrepancies"

  action nativeUiFlow =
    negotiateSupportedProfile
      .then(bindValidEnvelope)
      .then(startHost)
      .then(readyHost)
      .then(createView)
      .then(initializeUi)
      .then(notifyUiInitialized)

  action validProposalFlow =
    nativeUiFlow
      .then(captureInputSnapshot)
      .then(requestPropose)
      .then(returnCorrelatedProposal)

  action authorityAndAdmissionFlow =
    proposeExecutionCandidate
      .then(freezeCandidate)
      .then(authenticateEligibleHuman)
      .then(observeHandleAndSignature)
      .then(confirmCandidate)
      .then(establishTrust)
      .then(authorizeExecution)
      .then(issueGrant)
      .then(bindClaim)
      .then(admit)

  action admittedFlow = validProposalFlow.then(authorityAndAdmissionFlow)

  run normativeHappyPathTest =
    init
      .then(admittedFlow)
      .then(dispatch)
      .then(recordOutcome)
      .then(beginControlledTeardown)
      .then(finishControlledTeardown)
      .expect(all {
        haipSafety,
        boundedState,
        nativeIsolateMessagingOnlyRequired,
        capabilityTruthfulness,
        st.get("proposalMethod") == METHOD_PROPOSE,
        st.get("candidate") == C_CONFIRMED,
        st.get("grantConsumed") == ONE,
        st.get("outcome") == ONE,
      })

  run nativeProposeSuccessTest =
    init
      .then(validProposalFlow)
      .expect(all {
        haipSafety,
        nativeIsolateMessagingOnlyRequired,
        st.get("proposalAccepted") == ONE,
        st.get("proposalMethod") == METHOD_PROPOSE,
        st.get("proposalResponseId") == st.get("proposalRequestId"),
        st.get("proposalSource") == SOURCE_EXACT,
        st.get("resultOrigin") == ORIGIN_EXACT,
        st.get("inputSnapshotCount") == ONE,
        st.get("resultSnapshotCount") == ONE,
      })

  run nativeProposeFailureTest =
    init
      .then(nativeUiFlow)
      .then(captureInputSnapshot)
      .then(requestPropose)
      .then(rejectPropose)
      .expect(all {
        haipSafety,
        st.get("proposalAccepted") == ZERO,
        st.get("proposalRejected") == ONE,
        st.get("proposalMethod") == METHOD_PROPOSE,
        st.get("resultSnapshotCount") == ZERO,
      })

  run nativeValidEnvelopeTest =
    init
      .then(negotiateSupportedProfile)
      .then(bindValidEnvelope)
      .expect(all {
        exactEnvelopeBinding(st),
        haipSafety,
        nativeIsolateMessagingOnlyRequired,
      })

  run envelopeDigestMismatchTest =
    init
      .then(negotiateSupportedProfile)
      .then(rejectDigestMismatch)
      .expect(all {
        st.get("proposalRejected") == ONE,
        st.get("bindingLocked") == ZERO,
        not(exactEnvelopeBinding(st)),
        haipSafety,
      })

  run unsupportedRevisionTest =
    init
      .then(rejectUnsupportedProfile)
      .expect(all {
        st.get("profileRevision") == PROFILE_UNSUPPORTED,
        st.get("revisionAccepted") == ZERO,
        st.get("host") == HOST_ABSENT,
        haipSafety,
      })

  run preInitializationInputTest =
    init
      .then(negotiateSupportedProfile)
      .then(bindValidEnvelope)
      .then(rejectPreInitInput)
      .expect(all {
        st.get("inputSnapshotCount") == ZERO,
        st.get("proposalRejected") == ONE,
        haipSafety,
      })

  run duplicateInputSnapshotTest =
    init
      .then(nativeUiFlow)
      .then(captureInputSnapshot)
      .then(rejectDuplicateInputSnapshot)
      .expect(all {
        st.get("inputSnapshotCount") == ONE,
        st.get("duplicateSnapshot") == ONE,
        st.get("proposalRejected") == ONE,
        haipSafety,
      })

  run replayedProposalResultTest =
    init
      .then(validProposalFlow)
      .then(rejectProposalReplay)
      .expect(all {
        st.get("proposalReplay") == ONE,
        st.get("proposalAccepted") == ZERO,
        st.get("proposalRejected") == ONE,
        haipSafety,
      })

  run duplicateResultSnapshotTest =
    init
      .then(validProposalFlow)
      .then(rejectDuplicateResultSnapshot)
      .expect(all {
        st.get("resultSnapshotCount") == ONE,
        st.get("duplicateSnapshot") == ONE,
        st.get("proposalAccepted") == ZERO,
        haipSafety,
      })

  run forbiddenProposalMethodTest =
    init
      .then(nativeUiFlow)
      .then(rejectForbiddenMethod)
      .expect(all {
        st.get("proposalMethod") == METHOD_FORBIDDEN,
        st.get("forbiddenOperation") == ONE,
        st.get("proposalRejected") == ONE,
        haipSafety,
      })

  run wrongProposalSourceTest =
    init
      .then(nativeUiFlow)
      .then(rejectWrongSource)
      .expect(all {
        st.get("proposalSource") == SOURCE_WRONG,
        st.get("proposalAccepted") == ZERO,
        st.get("proposalRejected") == ONE,
        haipSafety,
      })

  run wrongProposalOriginTest =
    init
      .then(nativeUiFlow)
      .then(captureInputSnapshot)
      .then(requestPropose)
      .then(rejectWrongOrigin)
      .expect(all {
        st.get("resultOrigin") == ORIGIN_WRONG,
        st.get("proposalAccepted") == ZERO,
        st.get("proposalRejected") == ONE,
        haipSafety,
      })

  run capabilityTruthfulnessTest =
    init
      .then(validProposalFlow)
      .expect(all {
        haipSafety,
        capabilityTruthfulness,
        st.get("extraProposalMethods") == ZERO,
        st.get("proposalMethod") == METHOD_PROPOSE,
      })

  run abruptCrashTest =
    init
      .then(nativeUiFlow)
      .then(crashHost)
      .expect(all {
        st.get("host") == HOST_CRASHED,
        st.get("crash") == ONE,
        st.get("controlledTeardown") == ZERO,
        haipSafety,
      })

  run gracefulControlledTeardownTest =
    init
      .then(nativeUiFlow)
      .then(beginControlledTeardown)
      .then(finishControlledTeardown)
      .expect(all {
        st.get("host") == HOST_STOPPED,
        st.get("view") == VIEW_STOPPED,
        st.get("controlledTeardown") == ONE,
        haipSafety,
      })

  run unsupportedRevisionFallbackTest =
    init
      .then(rejectUnsupportedProfile)
      .then(activateTrustedFallback)
      .expect(all {
        st.get("fallbackTrusted") == ONE,
        st.get("fallbackUsed") == ONE,
        haipSafety,
      })

  run crashFallbackTest =
    init
      .then(nativeUiFlow)
      .then(crashHost)
      .then(activateTrustedFallback)
      .expect(all {
        st.get("host") == HOST_CRASHED,
        st.get("fallbackTrusted") == ONE,
        st.get("fallbackUsed") == ONE,
        haipSafety,
      })

  run appTransitionsCreateNoAuthorityTest =
    init
      .then(validProposalFlow)
      .expect(all {
        st.get("humanConfirmation") == ZERO,
        st.get("authorized") == ZERO,
        st.get("grantIssued") == ZERO,
        st.get("dispatch") == ZERO,
        st.get("effect") == EFFECT_NONE,
        appTransitionsCannotCreateAuthority(st),
      })

  run candidateDigestRaceTest =
    init
      .then(validProposalFlow)
      .then(proposeCandidate)
      .then(freezeWrongDigest)
      .then(authenticateEligibleHuman)
      .expect(not(validHumanConfirmation(st)))

  run ineligibleHumanRaceTest =
    init
      .then(validProposalFlow)
      .then(proposeCandidate)
      .then(freezeCandidate)
      .then(authenticateIneligibleHuman)
      .expect(not(validHumanConfirmation(st)))

  run duplicateConfirmationReplayTest =
    init
      .then(validProposalFlow)
      .then(proposeCandidate)
      .then(freezeCandidate)
      .then(authenticateEligibleHuman)
      .then(confirmCandidate)
      .expect(
        st.get("candidate") == C_CONFIRMED
          and not(validHumanConfirmation(st)))

  run dismissalWinsConfirmationRaceTest =
    init
      .then(validProposalFlow)
      .then(proposeCandidate)
      .then(freezeCandidate)
      .then(dismissCandidate)
      .expect(all {
        st.get("candidate") == C_DISMISSED,
        not(validHumanConfirmation(st)),
        st.get("humanConfirmation") == ZERO,
      })

  run handlesAndSignaturesDoNotCreateTrustTest =
    init
      .then(observeHandleAndSignature)
      .expect(all {
        st.get("handle") == ONE,
        st.get("signature") == ONE,
        st.get("trusted") == ZERO,
      })

  run reviewPurposeCannotUpgradeToExecutionTest =
    init
      .then(validProposalFlow)
      .then(proposeCandidate)
      .then(freezeCandidate)
      .then(authenticateEligibleHuman)
      .then(confirmCandidate)
      .expect(all {
        st.get("purpose") == PURPOSE_REVIEW,
        st.get("authorized") == ZERO,
        not(canAuthorizeExecution(st)),
        haipSafety,
      })

  run occurrenceClaimUniquenessTest =
    init
      .then(validProposalFlow)
      .then(proposeExecutionCandidate)
      .then(freezeCandidate)
      .then(authenticateEligibleHuman)
      .then(confirmCandidate)
      .then(authorizeExecution)
      .then(issueGrant)
      .then(bindClaim)
      .expect(st.get("claimCount") == ONE and not(canClaim(st)))

  run grantExpiryTest =
    init
      .then(validProposalFlow)
      .then(proposeExecutionCandidate)
      .then(freezeCandidate)
      .then(authenticateEligibleHuman)
      .then(confirmCandidate)
      .then(authorizeExecution)
      .then(issueGrant)
      .then(expireGrant)
      .expect(
        st.get("grantExpired") == ONE and not(grantUsable(st)))

  run grantRevocationTest =
    init
      .then(validProposalFlow)
      .then(proposeExecutionCandidate)
      .then(freezeCandidate)
      .then(authenticateEligibleHuman)
      .then(confirmCandidate)
      .then(authorizeExecution)
      .then(issueGrant)
      .then(revokeGrant)
      .expect(
        st.get("grantRevoked") == ONE and not(grantUsable(st)))

  run nativeCancellationUncertainEffectTest =
    init
      .then(admittedFlow)
      .then(cancelNativeAuthorization)
      .then(dispatchAfterCancellation)
      .then(recordUncertainEffect)
      .expect(all {
        haipSafety,
        st.get("haipCancelled") == ONE,
        st.get("dispatchAfterCancel") == ONE,
        st.get("effect") == EFFECT_UNCERTAIN,
      })


  run outcomeWithoutAdmissionWitnessTest =
    init
      .then(selectImplementation)
      .then(outcomeWithoutAdmission)
      .expect(outcomeWithoutAdmissionWitness and not(haipSafety))

  run multipleAdmissionsWitnessTest =
    init
      .then(selectImplementation)
      .then(admittedFlow)
      .then(duplicateAdmission)
      .expect(multipleAdmissionsWitness and not(haipSafety))

  run proposalFilteringWitnessTest =
    init
      .then(selectImplementation)
      .then(filterProposal)
      .expect(
        proposalFilteringWitness)

  run extraProposalMethodsWitnessTest =
    init
      .then(selectImplementation)
      .then(advertiseExtraProposalMethods)
      .expect(all {
        extraProposalMethodsWitness,
        not(capabilityTruthfulness),
        not(haipSafety),
      })

  run uncontrolledTeardownWitnessTest =
    init
      .then(selectImplementation)
      .then(nativeUiFlow)
      .then(stopHostWithoutControl)
      .expect(all {
        uncontrolledTeardownWitness,
        not(haipSafety),
      })


  run mutableEnvelopeWitnessTest =
    init
      .then(selectImplementation)
      .then(negotiateSupportedProfile)
      .then(bindValidEnvelope)
      .then(mutateLockedBinding)
      .expect(mutableEnvelopeWitness and not(haipSafety))

  run mutablePolicyWitnessTest =
    init
      .then(selectImplementation)
      .then(mutateFixedPolicy)
      .expect(mutablePolicyWitness and not(haipSafety))
}
