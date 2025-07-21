# Justfile for HAIP Package Management
# Run with: just <command>

# Default recipe
default:
    @just --list

# Set NVM version and install dependencies
setup:
    #!/usr/bin/env bash
    echo "🔧 Setting up HAIP development environment..."
    
    # Source NVM
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    
    # Set NVM version
    if command -v nvm &> /dev/null; then
        echo "📦 Setting Node.js version to 20..."
        nvm use 20 || nvm install 20
        nvm alias default 20
    else
        echo "⚠️  NVM not found. Please install NVM first:"
        echo "   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
        exit 1
    fi
    
    # Verify Node.js version
    node_version=$(node --version)
    echo "✅ Using Node.js: $node_version"
    
    # Install dependencies for all packages
    for package in haip-sdk haip-server haip-cli; do
        if [ -d "$package" ]; then
            echo "📦 Installing dependencies for $package..."
            cd "$package"
            npm install
            cd ..
        fi
    done
    
    echo "🎉 Setup complete!"

# Quick release all packages with patch version bumps
release:
    #!/usr/bin/env bash
    set -e
    
    # Colours
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
    
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
    
    # Source NVM
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    
    # Set NVM version
    if command -v nvm &> /dev/null; then
        print_status "Setting Node.js version to 20..."
        nvm use 20 || nvm install 20
    else
        print_error "NVM not found. Please install NVM first."
        exit 1
    fi
    
    # Configuration
    PACKAGES=("haip-sdk" "haip-server" "haip-cli")
    PACKAGE_NAMES=("@haip/sdk" "@haip/server" "@haip/cli")
    CURRENT_DIR=$(pwd)
    
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
        npm install
        
        # Build
        print_status "Building package..."
        npm run build
        
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

# Release a specific package
release-package package:
    #!/usr/bin/env bash
    set -e
    
    # Colours
    GREEN='\033[0;32m'
    RED='\033[0;31m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
    
    print_status() {
        echo -e "${BLUE}[INFO]${NC} $1"
    }
    
    print_success() {
        echo -e "${GREEN}[SUCCESS]${NC} $1"
    }
    
    print_error() {
        echo -e "${RED}[ERROR]${NC} $1"
    }
    
    # Source NVM
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    
    # Set NVM version
    if command -v nvm &> /dev/null; then
        print_status "Setting Node.js version to 20..."
        nvm use 20 || nvm install 20
    else
        print_error "NVM not found. Please install NVM first."
        exit 1
    fi
    
    # Package mapping
    case "{{package}}" in
        "sdk")
            package_dir="haip-sdk"
            package_name="@haip/sdk"
            ;;
        "server")
            package_dir="haip-server"
            package_name="@haip/server"
            ;;
        "cli")
            package_dir="haip-cli"
            package_name="@haip/cli"
            ;;
        *)
            print_error "Invalid package. Use: sdk, server, or cli"
            exit 1
            ;;
    esac
    
    # Check if logged into npm
    if ! npm whoami >/dev/null 2>&1; then
        print_error "Not logged into npm. Please run 'npm login' first"
        exit 1
    fi
    
    echo "🚀 Releasing $package_name"
    echo "========================"
    
    # Check if package directory exists
    if [ ! -d "$package_dir" ]; then
        print_error "Package directory $package_dir not found"
        exit 1
    fi
    
    cd "$package_dir"
    
    # Get current version
    current_version=$(node -p "require('./package.json').version")
    print_status "Current version: $current_version"
    
    # Clean and install
    print_status "Installing dependencies..."
    rm -rf node_modules package-lock.json
    npm install
    
    # Build
    print_status "Building package..."
    npm run build
    
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
    
    cd ..
    
    # Push tag
    print_status "Pushing git tag..."
    if git push origin "$tag_name"; then
        print_success "Pushed tag: $tag_name"
    fi
    
    echo
    print_success "🎉 Released $package_name@$new_version successfully!"

# Build all packages
build:
    #!/usr/bin/env bash
    set -e
    
    # Source NVM
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    
    # Set NVM version
    if command -v nvm &> /dev/null; then
        echo "📦 Setting Node.js version to 20..."
        nvm use 20 || nvm install 20
    else
        echo "⚠️  NVM not found. Please install NVM first."
        exit 1
    fi
    
    echo "🔨 Building all HAIP packages..."
    
    for package in haip-sdk haip-server haip-cli; do
        if [ -d "$package" ]; then
            echo "📦 Building $package..."
            cd "$package"
            npm install
            npm run build
            cd ..
        fi
    done
    
    echo "✅ All packages built successfully!"

# Format all packages
format:
    #!/usr/bin/env bash
    set -e
    
    # Source NVM
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    
    # Set NVM version
    if command -v nvm &> /dev/null; then
        echo "📦 Setting Node.js version to 20..."
        nvm use 20 || nvm install 20
    else
        echo "⚠️  NVM not found. Please install NVM first."
        exit 1
    fi
    
    echo "🎨 Formatting all HAIP packages..."
    
    for package in haip-sdk haip-server haip-cli; do
        if [ -d "$package" ]; then
            echo "📦 Formatting $package..."
            cd "$package"
            npm run format
            cd ..
        fi
    done
    
    echo "✅ All packages formatted successfully!"

# Lint all packages
lint:
    #!/usr/bin/env bash
    set -e
    
    # Source NVM
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    
    # Set NVM version
    if command -v nvm &> /dev/null; then
        echo "📦 Setting Node.js version to 20..."
        nvm use 20 || nvm install 20
    else
        echo "⚠️  NVM not found. Please install NVM first."
        exit 1
    fi
    
    echo "🔍 Linting all HAIP packages..."
    
    for package in haip-sdk haip-server haip-cli; do
        if [ -d "$package" ]; then
            echo "📦 Linting $package..."
            cd "$package"
            npm run lint
            cd ..
        fi
    done
    
    echo "✅ All packages linted successfully!"

# Fix linting issues in all packages
lint-fix:
    #!/usr/bin/env bash
    set -e
    
    # Source NVM
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    
    # Set NVM version
    if command -v nvm &> /dev/null; then
        echo "📦 Setting Node.js version to 20..."
        nvm use 20 || nvm install 20
    else
        echo "⚠️  NVM not found. Please install NVM first."
        exit 1
    fi
    
    echo "🔧 Fixing linting issues in all HAIP packages..."
    
    for package in haip-sdk haip-server haip-cli; do
        if [ -d "$package" ]; then
            echo "📦 Fixing $package..."
            cd "$package"
            npm run lint:fix
            cd ..
        fi
    done
    
    echo "✅ All packages linting issues fixed successfully!"

# Test all packages
test:
    #!/usr/bin/env bash
    set -e
    
    # Source NVM
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    
    # Set NVM version
    if command -v nvm &> /dev/null; then
        echo "📦 Setting Node.js version to 20..."
        nvm use 20 || nvm install 20
    else
        echo "⚠️  NVM not found. Please install NVM first."
        exit 1
    fi
    
    echo "🧪 Testing all HAIP packages..."
    
    for package in haip-sdk haip-server haip-cli; do
        if [ -d "$package" ]; then
            echo "📦 Testing $package..."
            cd "$package"
            npm install
            npm test || echo "⚠️  Tests failed for $package, but continuing..."
            cd ..
        fi
    done
    
    echo "✅ Testing completed!"

# Clean all packages
clean:
    #!/usr/bin/env bash
    echo "🧹 Cleaning all HAIP packages..."
    
    for package in haip-sdk haip-server haip-cli; do
        if [ -d "$package" ]; then
            echo "📦 Cleaning $package..."
            cd "$package"
            rm -rf node_modules package-lock.json dist build
            cd ..
        fi
    done
    
    echo "✅ All packages cleaned!"

# Show current versions
versions:
    #!/usr/bin/env bash
    echo "📋 Current package versions:"
    echo
    
    for package in haip-sdk haip-server haip-cli; do
        if [ -d "$package" ]; then
            version=$(node -p "require('./$package/package.json').version")
            name=$(node -p "require('./$package/package.json').name")
            echo "✅ $name@$version"
        fi
    done

# Show Node.js and npm versions
env:
    #!/usr/bin/env bash
    echo "🔧 Environment Information:"
    echo
    
    # Source NVM
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
    
    # Set NVM version
    if command -v nvm &> /dev/null; then
        echo "📦 Setting Node.js version to 20..."
        nvm use 20 || nvm install 20
        echo "📦 NVM: $(nvm --version)"
        echo "📦 Node.js: $(node --version)"
        echo "📦 npm: $(npm --version)"
    else
        echo "⚠️  NVM not found"
        echo "📦 Node.js: $(node --version)"
        echo "📦 npm: $(npm --version)"
    fi
    
    echo
    echo "📋 Available packages:"
    for package in haip-sdk haip-server haip-cli; do
        if [ -d "$package" ]; then
            echo "✅ $package"
        else
            echo "❌ $package (not found)"
        fi
    done 