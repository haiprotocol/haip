# HAIP Packages Release Scripts

This directory contains scripts to automate the release process for all three HAIP packages.

## Scripts Overview

### 1. `release-haip-packages.sh` - Full Release Script
A comprehensive release script with interactive version bumping and full validation.

**Features:**
- Interactive version bump selection (patch/minor/major/custom)
- Prerequisites checking (Node.js, npm, git, npm login)
- Git status validation
- Build and test each package
- Version bumping with confirmation
- Publishing to npm with public access
- Git tag creation and pushing
- Detailed progress reporting

**Usage:**
```bash
./release-haip-packages.sh
```

### 2. `quick-release.sh` - Quick Release Script
A simplified script for quick patch version releases.

**Features:**
- Automatic patch version bumps
- Minimal prompts
- Continues on test failures (with warning)
- Quick release cycle

**Usage:**
```bash
./quick-release.sh
```

## Prerequisites

Before running either script, ensure you have:

1. **Node.js and npm** installed
2. **Git** installed and configured
3. **npm login** completed for the `@haip` organisation
4. **Write access** to the npm packages

## Package Configuration

The scripts handle these packages:

| Directory | Package Name | Description |
|-----------|--------------|-------------|
| `haip-sdk` | `@haip/sdk` | TypeScript SDK for HAIP |
| `haip-server` | `@haip/server` | Reference HAIP server |
| `haip-cli` | `@haip/cli` | Command-line interface |

## Release Process

### Full Release Process (`release-haip-packages.sh`)

1. **Prerequisites Check**
   - Verify Node.js, npm, and git are installed
   - Check npm login status
   - Validate git status

2. **Version Planning**
   - Show current versions
   - Prompt for version bump type for each package
   - Allow skipping packages

3. **Package Processing**
   - Build each package
   - Run tests (with option to continue on failure)
   - Bump version
   - Publish to npm
   - Create git tags

4. **Finalization**
   - Push all git tags
   - Show release summary

### Quick Release Process (`quick-release.sh`)

1. **Confirmation**
   - Single confirmation prompt
   - Automatic patch version bumps

2. **Package Processing**
   - Clean install dependencies
   - Build packages
   - Run tests (continue on failure)
   - Bump patch version
   - Publish to npm
   - Create git tags

3. **Finalization**
   - Push git tags
   - Show release summary

## Version Bumping

### Semantic Versioning
- **Patch**: Bug fixes and minor updates (1.0.0 → 1.0.1)
- **Minor**: New features, backward compatible (1.0.0 → 1.1.0)
- **Major**: Breaking changes (1.0.0 → 2.0.0)

### Version Selection
The full release script offers these options:
1. **patch** - Increment patch version
2. **minor** - Increment minor version
3. **major** - Increment major version
4. **custom** - Enter specific version
5. **skip** - Skip this package

## Error Handling

### Build Failures
- Script stops on build failures
- Check package.json and build configuration

### Test Failures
- Full script: Option to continue or abort
- Quick script: Continues with warning

### Publishing Failures
- Script stops on publishing failures
- Check npm permissions and package configuration

### Git Issues
- Warns about uncommitted changes
- Option to continue or abort
- Handles existing tags gracefully

## Troubleshooting

### Common Issues

1. **npm login required**
   ```bash
   npm login
   ```

2. **Permission denied**
   - Ensure you have write access to `@haip` organisation
   - Check npm organisation membership

3. **Build failures**
   - Check TypeScript compilation
   - Verify all dependencies are installed
   - Check package.json scripts

4. **Test failures**
   - Review test output for specific failures
   - Consider fixing tests before release
   - Use quick-release script to bypass test failures

5. **Git tag conflicts**
   - Delete existing tags if needed
   - Check for duplicate version numbers

### Pre-release Checklist

- [ ] All tests passing
- [ ] Documentation updated
- [ ] CHANGELOG updated
- [ ] Version numbers consistent
- [ ] npm login completed
- [ ] Git status clean
- [ ] Backup of current state

## Post-release Tasks

After successful release:

1. **Update Documentation**
   - Update installation instructions
   - Update version references
   - Update implementation status

2. **Create GitHub Releases**
   - Create releases for each package
   - Include changelog and release notes

3. **Verify Installation**
   ```bash
   npm install @haip/sdk
   npm install @haip/server
   npm install @haip/cli
   ```

4. **Update Status Documents**
   - Update `IMPLEMENTATION_STATUS.md`
   - Update `AUDIT_SUMMARY.md`
   - Remove "Coming Soon" references

## Script Customization

### Adding New Packages
Edit the `PACKAGES` and `PACKAGE_NAMES` arrays in both scripts:

```bash
PACKAGES=("haip-sdk" "haip-server" "haip-cli" "new-package")
PACKAGE_NAMES=("@haip/sdk" "@haip/server" "@haip/cli" "@haip/new-package")
```

### Modifying Build Process
Edit the `build_package()` function to add custom build steps.

### Adding Pre-release Hooks
Add validation functions before the main release process.

## Security Considerations

- Scripts use `npm ci` for reproducible builds
- Clean installs prevent dependency injection
- Version validation prevents duplicate releases
- Git status checking prevents accidental releases

## Support

For issues with the release scripts:

1. Check the error messages for specific issues
2. Verify all prerequisites are met
3. Review the troubleshooting section
4. Check package-specific documentation 