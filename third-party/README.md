The native HAIP Agent UI Host/View path no longer depends on MCP Apps or the MCP TypeScript SDK.

# Third-party notices

HAIP's original MIT licence and San Digital attribution remain unchanged. Review
bundle registration never changes authorship or licensing.

The browser host uses MCP ext-apps 1.7.4 and MCP SDK 1.29.0. Their complete shipped
licences are retained alongside this notice, including the upstream MIT/Apache-2.0
transition wording. The bundles also contain Zod 4.5.4 (MIT) and zod-to-json-schema
3.25.2 (ISC); their complete notices are retained here. Browser scripts include these
notices, server packages carry this directory, and the standalone example App embeds
the notices in its HTML. Generated browser bundles also retain bundled legal comments.

Historical CHAP primitive sources are research material under their retained
Apache-2.0 licence, not the HAIP response canonicaliser. Their integer-only rule is
not adopted. HAIP supports valid decimal responses and tests authoritative RFC vectors.

Plasm's renderer remains in its owning repository. No Plasm renderer implementation
is vendored into HAIP or relicensed as MIT. The recorded parent revision
`835d276a4652e1505c29467018ba61dcf87b3ce2` carries a GPL-3.0 root licence, separate from
Plasm Core's MIT/Apache-2.0 licences and its trace sink's BUSL licence. Renderer
distribution needs the applicable notices and source obligations checked against its
exact source revision. The independently authored test app uses MCP libraries with the notices
above. Historical renderer screenshots and data are feasibility evidence only.
