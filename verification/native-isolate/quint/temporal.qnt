module temporal_properties {
  import domain.* from "./domain"
  import composition.* from "./composition"

  temporal admittedEventuallyTerminates =
    leadsTo(
      st.get("admissions") == ONE,
      st.get("dispatch") == ONE or st.get("haipCancelled") == ONE)

  temporal dispatchedEventuallyHasOutcome =
    leadsTo(st.get("dispatch") == ONE, st.get("outcome") == ONE)

  // Accepted haip/ui.propose always follows native initialize/initialized.
  temporal acceptedProposalWasInitialized =
    always((st.get("proposalAccepted") == ONE).implies(
      st.get("uiInitialized") == ONE))

  temporal stoppedHostWasControlled =
    always((st.get("host") == HOST_STOPPED).implies(
      st.get("controlledTeardown") == ONE))

  temporal crashedHostStaysCrashed =
    always((st.get("crash") == ONE).implies(
      st.get("host") == HOST_CRASHED))

  temporal uncertainEffectRequiresCancellationRace =
    always((st.get("effect") == EFFECT_UNCERTAIN).implies(
      st.get("haipCancelled") == ONE
        and st.get("dispatchAfterCancel") == ONE))
}
