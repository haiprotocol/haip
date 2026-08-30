# Hosting, storage and identity choices

Owner preference, confirmed 30 August 2026: **use free tiers first; no Amazon services**.
Cloudflare, Vercel and Clerk are candidates where their actual limits and security
properties fit. If paid infrastructure or authentication is necessary, prefer Azure
and obtain explicit approval first. No subscriptions, deployments or cloud resources
have been created. Local development/tests need no paid account.

Production dependencies contain no Amazon SDK. Development-only Nodemailer type
definitions pull in unused SES types; they configure or contact no Amazon service.

| Component                          | Default approach                                      | Constraint                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Development and acceptance tests   | Local Node/PostgreSQL, isolated OIDC and mock effects | No cloud bill; fixtures never claim production guarantees                                                                  |
| Public documentation/static assets | Existing hosting or a suitable Cloudflare free tier   | Publishing requires separate authorisation                                                                                 |
| Encrypted backup objects           | R2 Standard is a candidate                            | 10 GB-month, 1 million writes and 10 million reads are currently included; subscription/billing setup still needs approval |
| Human authentication               | Standards-based OIDC; Clerk is a candidate            | Keep HAIP server-side sessions, CSRF and operator mappings; validate the actual OAuth application configuration            |
| Reference runtime                  | Existing/self-hosted Node 24 and PostgreSQL           | Persistent worker and single-process generation ownership; not a drop-in serverless function                               |
| Strict production audit/recovery   | Optional Azure Blob locked WORM adapter               | Not assumed free; independent administration, versioning, locked retention and permanent safety holds required             |

R2's bucket locks prevent overwrites and deletion while enabled, but administrators
can remove those rules. They are **not** represented as irreversible compliance-mode
retention. R2 is suitable for encrypted backups with a bounded lifecycle, but is not
silently substituted for the stricter production audit requirement. Backups are private,
client-encrypted and deleted within 30 days; never expose them via a public bucket.

Vercel Hobby restricts use to personal, non-commercial projects. It is not an assumed
free deployment for commercial workloads. Its serverless lifecycle also differs from
this persistent Node/PostgreSQL service; switching runtime models needs explicit design
and validation, not just a hosting configuration file.

Clerk currently includes 50,000 monthly retained users on its free plan. Using Clerk
as HAIP's OAuth/OIDC provider differs from purchasing inbound enterprise SSO. Configure
an OAuth application with the exact HAIP callback, the `openid` scope, PKCE and
confidential client authentication. If using its OAuth metadata endpoint, set
`HAIP_OIDC_DISCOVERY=oauth2` and `HAIP_OIDC_CLIENT_AUTH=client_secret_basic`, alongside
the issuer, client ID and secret. The generic flow is tested locally; real Clerk account
interoperability and plan availability still need validation. No Clerk browser SDK or
token is exposed to producer Apps. Azure Entra or another compatible provider remains
configurable through the same interface.

Sources checked 30 August 2026: [R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[R2 locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/),
[Vercel Hobby](https://vercel.com/docs/plans/hobby), [Clerk pricing](https://clerk.com/pricing),
[Clerk OAuth/OIDC](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth),
[Azure immutable storage](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview).
Recheck terms before deployment; free quotas are not a commitment to a future bill.
