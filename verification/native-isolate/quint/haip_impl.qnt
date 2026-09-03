module haip_impl {
  import domain.* from "./domain"

  // Deliberately preserved implementation observations, not normative permission.
  pure def observedOutcomeWithoutAdmission(s: str -> int): bool =
    s.get("outcome") == ONE and s.get("admissions") == ZERO

  pure def observedMultipleAdmissions(s: str -> int): bool =
    s.get("admissions") == TWO

  pure def implementationHaipShape(s: str -> int): bool = all {
    boundedCount(s.get("admissions")),
    bit(s.get("outcome")),
  }
}
