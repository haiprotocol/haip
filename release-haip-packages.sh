#!/bin/bash

# HAIP Packages Release Script
# This script builds, tests, and publishes all three HAIP packages to npm

set -e  # Exit on any error

# Colours for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Colour

# Configuration
PACKAGES=("haip-sdk" "haip-server" "haip-cli")
PACKAGE_NAMES=("haip-sdk" "@haip-protocol/server" "@haip-protocol/cli")
CURRENT_DIR=$(pwd)

# Function to print coloured output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    if ! command_exists node; then
        print_error "Node.js is not installed"
        exit 1
    fi
    
    if ! command_exists npm; then
        print_error "npm is not installed"
        exit 1
    fi
    
    if ! command_exists git; then
        print_error "git is not installed"
        exit 1
    fi
    
    # Check if logged into npm
    if ! npm whoami >/dev/null 2>&1; then
        print_error "Not logged into npm. Please run 'npm login' first"
        exit 1
    fi
    
    print_success "Prerequisites check passed"
}

# Function to check git status
check_git_status() {
    print_status "Checking git status..."
    
    if [ -n "$(git status --porcelain)" ]; then
        print_warning "There are uncommitted changes. Please commit or stash them before releasing."
        read -p "Continue anyway? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
    
    print_success "Git status check passed"
}

# Function to get current version from package.json
get_current_version() {
    local package_dir=$1
    node -p "require('./$package_dir/package.json').version"
}

# Function to prompt for version bump
prompt_version_bump() {
    local package_name=$1
    local current_version=$2
    
    echo
    print_status "Current version of $package_name: $current_version"
    echo "Choose version bump type:"
    echo "1) patch (1.0.0 -> 1.0.1)"
    echo "2) minor (1.0.0 -> 1.1.0)"
    echo "3) major (1.0.0 -> 2.0.0)"
    echo "4) custom version"
    echo "5) skip this package"
    
    read -p "Enter choice (1-5): " choice
    
    case $choice in
        1)
            echo "patch"
            ;;
        2)
            echo "minor"
            ;;
        3)
            echo "major"
            ;;
        4)
            read -p "Enter custom version (e.g., 1.2.3): " custom_version
            echo "$custom_version"
            ;;
        5)
            echo "skip"
            ;;
        *)
            print_error "Invalid choice"
            exit 1
            ;;
    esac
}

# Function to build package
build_package() {
    local package_dir=$1
    local package_name=$2
    
    print_status "Building $package_name..."
    
    cd "$package_dir"
    
    # Clean previous build
    if [ -d "dist" ]; then
        rm -rf dist
    fi
    
    # Install dependencies
    npm ci
    
    # Build package
    npm run build
    
    # Check if build was successful
    if [ ! -d "dist" ]; then
        print_error "Build failed for $package_name - dist directory not found"
        exit 1
    fi
    
    print_success "Built $package_name successfully"
    cd "$CURRENT_DIR"
}

# Function to test package
test_package() {
    local package_dir=$1
    local package_name=$2
    
    print_status "Testing $package_name..."
    
    cd "$package_dir"
    
    # Run tests
    if npm test; then
        print_success "Tests passed for $package_name"
    else
        print_warning "Tests failed for $package_name"
        read -p "Continue with release anyway? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            cd "$CURRENT_DIR"
            exit 1
        fi
    fi
    
    cd "$CURRENT_DIR"
}

# Function to update version
update_version() {
    local package_dir=$1
    local version_bump=$2
    
    print_status "Updating version for $package_dir..."
    
    cd "$package_dir"
    
    if [ "$version_bump" = "skip" ]; then
        print_warning "Skipping version update for $package_dir"
        cd "$CURRENT_DIR"
        return
    fi
    
    # Update version
    if [ "$version_bump" = "patch" ] || [ "$version_bump" = "minor" ] || [ "$version_bump" = "major" ]; then
        npm version "$version_bump" --no-git-tag-version
    else
        npm version "$version_bump" --no-git-tag-version
    fi
    
    local new_version=$(get_current_version ".")
    print_success "Updated $package_dir to version $new_version"
    
    cd "$CURRENT_DIR"
}

# Function to publish package
publish_package() {
    local package_dir=$1
    local package_name=$2
    
    print_status "Publishing $package_name..."
    
    cd "$package_dir"
    
    # Check if package is already published
    local current_version=$(get_current_version ".")
    if npm view "$package_name@$current_version" version >/dev/null 2>&1; then
        print_warning "Version $current_version of $package_name is already published"
        read -p "Continue with publishing? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            cd "$CURRENT_DIR"
            return
        fi
    fi
    
    # Publish to npm
    if npm publish --access public; then
        print_success "Published $package_name@$current_version to npm"
    else
        print_error "Failed to publish $package_name"
        cd "$CURRENT_DIR"
        exit 1
    fi
    
    cd "$CURRENT_DIR"
}

# Function to create git tag
create_git_tag() {
    local package_dir=$1
    local package_name=$2
    
    cd "$package_dir"
    local version=$(get_current_version ".")
    cd "$CURRENT_DIR"
    
    local tag_name="${package_name}-v${version}"
    
    print_status "Creating git tag: $tag_name"
    
    if git tag "$tag_name"; then
        print_success "Created git tag: $tag_name"
    else
        print_warning "Failed to create git tag: $tag_name (may already exist)"
    fi
}

# Function to push tags
push_git_tags() {
    print_status "Pushing git tags..."
    
    if git push --tags; then
        print_success "Pushed git tags successfully"
    else
        print_warning "Failed to push git tags"
    fi
}

# Function to show release summary
show_release_summary() {
    echo
    print_success "Release Summary:"
    echo "=================="
    
    for i in "${!PACKAGES[@]}"; do
        local package_dir="${PACKAGES[$i]}"
        local package_name="${PACKAGE_NAMES[$i]}"
        local version=$(get_current_version "$package_dir")
        
        echo "✅ $package_name@$version"
    done
    
    echo
    print_success "All packages have been released successfully!"
    echo
    echo "Next steps:"
    echo "1. Update documentation to reflect new versions"
    echo "2. Create GitHub releases for each package"
    echo "3. Update implementation status documents"
    echo "4. Test the published packages"
}

# Main release process
main() {
    echo "🚀 HAIP Packages Release Script"
    echo "================================"
    echo
    
    # Check prerequisites
    check_prerequisites
    
    # Check git status
    check_git_status
    
    # Store version bumps
    declare -A version_bumps
    
    # Get version bumps for each package
    for i in "${!PACKAGES[@]}"; do
        local package_dir="${PACKAGES[$i]}"
        local package_name="${PACKAGE_NAMES[$i]}"
        local current_version=$(get_current_version "$package_dir")
        
        version_bumps[$package_dir]=$(prompt_version_bump "$package_name" "$current_version")
    done
    
    echo
    print_status "Starting release process..."
    echo
    
    # Process each package
    for i in "${!PACKAGES[@]}"; do
        local package_dir="${PACKAGES[$i]}"
        local package_name="${PACKAGE_NAMES[$i]}"
        local version_bump="${version_bumps[$package_dir]}"
        
        echo "📦 Processing $package_name"
        echo "========================"
        
        # Skip if requested
        if [ "$version_bump" = "skip" ]; then
            print_warning "Skipping $package_name"
            echo
            continue
        fi
        
        # Build package
        build_package "$package_dir" "$package_name"
        
        # Test package
        test_package "$package_dir" "$package_name"
        
        # Update version
        update_version "$package_dir" "$version_bump"
        
        # Publish package
        publish_package "$package_dir" "$package_name"
        
        # Create git tag
        create_git_tag "$package_dir" "$package_name"
        
        echo
    done
    
    # Push git tags
    push_git_tags
    
    # Show release summary
    show_release_summary
}

# Run main function
main "$@" 