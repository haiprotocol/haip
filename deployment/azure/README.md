# Azure storage

[`main.bicep`](main.bicep) defines the storage boundary for a future isolated HAIP deployment. It has not been deployed. It creates a StorageV2 account with versioning, a private checkpoint container with version-level WORM support and an unlocked default 90-day policy, a private safety container with an unlocked container-level 90-day policy, a user-assigned managed identity, a custom data role and one role assignment scoped to each container.

The template excludes compute, PostgreSQL, DNS, certificates, identity applications, monitoring and backup storage. It does not assign an administrator or create locked evidence. Those choices remain part of the reviewed deployment and acceptance procedure.

## Review

Compile the template locally before review:

```sh
az bicep build --file deployment/azure/main.bicep --stdout >/private/haip-acceptance/main.json
```

After selecting the Azure subscription, resource group, region, globally unique account name and network boundary, inspect the proposed changes without applying them:

```sh
az deployment group what-if --resource-group REPLACE_ME --template-file deployment/azure/main.bicep --parameters storageAccountName=REPLACE_ME allowedIpCidrs='["REPLACE_ME"]'
```

Do not run a create deployment until the cost of retained resources, storage administrator, runtime identity custody and cleanup limits have been approved. Version-level immutability support changes the checkpoint container's capability. The template creates the checkpoint default policy and safety container policy in their unlocked state because locking them and applying the safety legal hold are separate administrator operations.

## Compatibility

`AzureAnchor` writes checkpoints to the checkpoint container without per-version policy headers. `AzureSafetyStore` writes recovery fences to the safety container without per-version policy or hold headers. Both read the exact returned version and require inherited Locked retention for at least 90 days. The safety read also requires the inherited legal hold.

Azure documents `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/immutableStorage/runAsSuperUser/action` as the permission for setting a blob immutability policy. The same capability can remove a policy, so the runtime role does not receive it. See the [Azure data-operation permissions](https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-azure-active-directory#permissions-for-calling-data-operations) and [immutability policy authorisation](https://learn.microsoft.com/en-us/rest/api/storageservices/set-blob-immutability-policy#permissions).

Before runtime access, an independent administrator must lock the checkpoint container's default version-level policy and the safety container's container-level policy, then apply a container-level legal hold to the safety container. Azure's [immutable storage overview](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview#scope) says a container legal hold cannot share that container with version-level WORM, so version-level WORM is enabled only for checkpoints. Account blob versioning still supplies exact version IDs for safety records. The checkpoint container remains outside the legal hold. The template leaves these administrator operations unapplied, and no live Azure check has run.

## Runtime role

The custom role grants blob add and read data actions on both evidence containers. Read covers listing and properties. It omits blob replacement, deletion, version deletion, permanent deletion, container administration and immutable-storage superuser actions. Shared keys, local users, SFTP, NFS and public blob access are disabled.

Azure permissions are additive. The exact allowlist in this custom role does not override another assignment. Inspect the managed identity's complete effective access, then use it to prove that replacement, deletion, hold clearing, retention changes, container changes, account key access and control plane changes are refused.

The storage firewall starts with `defaultAction: Deny` and no bypass. Supply an approved source IPv4 CIDR or subnet. A private endpoint and its DNS are outside this template and can replace public endpoint access in a later reviewed deployment.

## Runtime values

The outputs supply public configuration values for the HAIP process:

```text
AZURE_CLIENT_ID=<runtimeClientId>
HAIP_AZURE_ACCOUNT_URL=<accountUrl>
HAIP_AZURE_CONTAINER=<checkpointContainer>
HAIP_AZURE_SAFETY_CONTAINER=<safetyContainer>
HAIP_ANCHOR_INDEPENDENT_ADMIN=true
```

`HAIP_ANCHOR_INDEPENDENT_ADMIN=true` records an operator assertion. It does not prove that administration is independent. Use managed identity on the selected runtime and do not export a client secret when the hosting environment supports that identity.

## Live proof

Real acceptance must show conditional add-only creation, an exact version read, inherited Locked retention for at least 90 days in both containers, a legal hold on every safety record, safe duplicate recovery and refusal on conflicting, extra or deleted versions. It must also show the denied runtime operations listed above and prove that the checkpoint and safety container names differ. The local Azure adapter test uses an in-memory transport and cannot supply this proof.
