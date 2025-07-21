#!/bin/bash

# Quick Release Script for HAIP Packages
# This script quickly releases all packages with patch version bumps

set -e

# Colours
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
PACKAGES=("haip-sdk" "haip-server" "haip-cli")
PACKAGE_NAMES=("haip-sdk" "@haip-protocol/server" "@haip-protocol/cli")
CURRENT_DIR=$(pwd)

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Check if logged into npm
if ! npm whoami >/dev/null 2>&1; then
    print_error "Not logged into npm. Please run 'npm login' first"
    exit 1
fi

echo "🚀 Quick Release - HAIP Packages"
echo "================================"
echo

# Confirm release
read -p "This will release all packages with patch version bumps. Continue? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

# Process each package
for i in "${!PACKAGES[@]}"; do
    package_dir="${PACKAGES[$i]}"
    package_name="${PACKAGE_NAMES[$i]}"
    
    echo "📦 Processing $package_name"
    echo "========================"
    
    cd "$package_dir"
    
    # Get current version
    current_version=$(node -p "require('./package.json').version")
    print_status "Current version: $current_version"
    
    # Clean and install
    print_status "Installing dependencies..."
    rm -rf node_modules package-lock.json
    npm ci
    
    # Build
    print_status "Building package..."
    npm run build
    
    # Test (continue on failure)
    print_status "Running tests..."
    if ! npm test; then
        print_warning "Tests failed, but continuing..."
    fi
    
    # Bump version
    print_status "Bumping patch version..."
    npm version patch --no-git-tag-version
    
    # Get new version
    new_version=$(node -p "require('./package.json').version")
    print_success "Version bumped to: $new_version"
    
    # Publish
    print_status "Publishing to npm..."
    if npm publish --access public; then
        print_success "Published $package_name@$new_version"
    else
        print_error "Failed to publish $package_name"
        exit 1
    fi
    
    # Create git tag
    tag_name="${package_name}-v${new_version}"
    if git tag "$tag_name"; then
        print_success "Created tag: $tag_name"
    fi
    
    cd "$CURRENT_DIR"
    echo
done

# Push all tags
print_status "Pushing git tags..."
if git push --tags; then
    print_success "Pushed all tags"
fi

echo
print_success "🎉 Quick release completed successfully!"
echo
echo "Released packages:"
for i in "${!PACKAGES[@]}"; do
    package_dir="${PACKAGES[$i]}"
    package_name="${PACKAGE_NAMES[$i]}"
    version=$(node -p "require('./$package_dir/package.json').version")
    echo "✅ $package_name@$version"
done 