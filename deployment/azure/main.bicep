targetScope = 'resourceGroup'

@description('Azure region for the acceptance storage account and runtime identity.')
param location string = resourceGroup().location

@description('Globally unique lowercase storage account name.')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Private container for HAIP checkpoints.')
@minLength(3)
@maxLength(63)
param checkpointContainerName string = 'haip-checkpoints'

@description('Private container for HAIP safety records. An independent administrator applies its legal hold.')
@minLength(3)
@maxLength(63)
param safetyContainerName string = 'haip-safety'

@description('User-assigned identity used by the HAIP runtime.')
@minLength(3)
@maxLength(128)
param runtimeIdentityName string = 'haip-acceptance-runtime'

@description('IPv4 CIDR ranges allowed to reach the storage data endpoint.')
param allowedIpCidrs array = []

@description('Subnet resource IDs allowed to reach the storage data endpoint.')
param allowedSubnetIds array = []

@description('Resource tags recorded on the acceptance resources.')
param tags object = {}

var roleGuid = guid(subscription().id, resourceGroup().id, storageAccountName, 'haip-evidence-writer-v1')
var roleName = 'HAIP evidence writer ${uniqueString(resourceGroup().id, storageAccountName)}'

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: runtimeIdentityName
  location: location
  tags: tags
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    isHnsEnabled: false
    isLocalUserEnabled: false
    isNfsV3Enabled: false
    isSftpEnabled: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Deny'
      ipRules: [for cidr in allowedIpCidrs: {
        action: 'Allow'
        value: cidr
      }]
      resourceAccessRules: []
      virtualNetworkRules: [for subnetId in allowedSubnetIds: {
        action: 'Allow'
        id: subnetId
      }]
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: {
        blob: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    automaticSnapshotPolicyEnabled: false
    changeFeed: {
      enabled: false
    }
    containerDeleteRetentionPolicy: {
      enabled: false
    }
    deleteRetentionPolicy: {
      enabled: false
    }
    isVersioningEnabled: true
    restorePolicy: {
      enabled: false
    }
  }
}

resource checkpointEvidenceContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: checkpointContainerName
  properties: {
    defaultEncryptionScope: '$account-encryption-key'
    denyEncryptionScopeOverride: true
    immutableStorageWithVersioning: {
      enabled: true
    }
    publicAccess: 'None'
  }
}

resource checkpointRetention 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = {
  parent: checkpointEvidenceContainer
  name: 'default'
  properties: {
    allowProtectedAppendWrites: false
    allowProtectedAppendWritesAll: false
    immutabilityPeriodSinceCreationInDays: 90
  }
}

resource safetyEvidenceContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: safetyContainerName
  properties: {
    defaultEncryptionScope: '$account-encryption-key'
    denyEncryptionScopeOverride: true
    publicAccess: 'None'
  }
}

resource safetyRetention 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = {
  parent: safetyEvidenceContainer
  name: 'default'
  properties: {
    allowProtectedAppendWrites: false
    allowProtectedAppendWritesAll: false
    immutabilityPeriodSinceCreationInDays: 90
  }
}

resource writerRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: roleGuid
  properties: {
    assignableScopes: [
      resourceGroup().id
    ]
    description: 'Add and read HAIP evidence without replacement, deletion or policy administration.'
    permissions: [
      {
        actions: []
        notActions: []
        dataActions: [
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action'
          'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'
        ]
        notDataActions: []
      }
    ]
    roleName: roleName
    type: 'CustomRole'
  }
}

resource checkpointWriterAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: checkpointEvidenceContainer
  name: guid(checkpointEvidenceContainer.id, runtimeIdentity.id, writerRole.id)
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: writerRole.id
  }
}

resource safetyWriterAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: safetyEvidenceContainer
  name: guid(safetyEvidenceContainer.id, runtimeIdentity.id, writerRole.id)
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: writerRole.id
  }
}

output accountUrl string = storage.properties.primaryEndpoints.blob
output checkpointContainer string = checkpointEvidenceContainer.name
output safetyContainer string = safetyEvidenceContainer.name
output runtimeClientId string = runtimeIdentity.properties.clientId
output runtimeIdentityResourceId string = runtimeIdentity.id
output runtimePrincipalId string = runtimeIdentity.properties.principalId
output writerRoleDefinitionId string = writerRole.id
output checkpointRetentionPolicyId string = checkpointRetention.id
output safetyRetentionPolicyId string = safetyRetention.id
