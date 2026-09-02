module variants {
  import domain.* from "./domain"

  type Variant = int
  pure val Normative = ZERO
  pure val Implementation = ONE

  pure def isNormative(v: Variant): bool = v == Normative
  pure def permitsOutcomeWithoutAdmission(v: Variant): bool = v == Implementation
  pure def permitsMultipleAdmissions(v: Variant): bool = v == Implementation
  pure def permitsProposalFiltering(v: Variant): bool = v == Implementation
  pure def advertisesExtraProposalMethods(v: Variant): bool = v == Implementation
  pure def permitsUncontrolledTeardown(v: Variant): bool = v == Implementation
}
