import type { KeyObject } from 'node:crypto';
import type { Limits, Profiles, TrustManifest } from '@haip/protocol';
export interface Principal {
  tenant: string;
  id: string;
  kind: 'producer' | 'publisher' | 'operator' | 'human';
  config: {
    enabled: boolean;
    identity_certain?: boolean;
    publisher?: string;
    routes?: string[];
    owner?: string;
    oidc_issuer?: string;
    oidc_subject?: string;
    email?: string;
    email_verified?: boolean;
    webhook?: string;
    [key: string]: unknown;
  };
}
export interface RouteConfig {
  reviewers: string[];
  separation_of_duties: boolean;
  limits: Limits;
  required_profiles: Profiles;
  allowed_producers: string[];
  modes: string[];
}
export interface ServiceConfig {
  origin: string;
  issuer: string;
  keyId: string;
  signingKey: KeyObject;
  trust: TrustManifest;
  mode: 'development' | 'production';
  sandboxOrigin: (scope: string) => string;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    allowLocalHttp?: boolean;
    discovery?: 'oidc' | 'oauth2';
    clientAuth?: 'client_secret_post' | 'client_secret_basic';
  };
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    auth?: { user: string; pass: string };
    from: string;
  };
  webhookHosts: string[];
}
