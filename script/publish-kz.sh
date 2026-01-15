#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCODE_DIR="$ROOT_DIR/packages/opencode"

# Read current version
CURRENT_VERSION=$(grep '"version"' "$OPENCODE_DIR/package.json" | sed 's/.*"\([0-9.]*\)".*/\1/')

# Calculate next patch version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
NEXT_VERSION="$MAJOR.$MINOR.$((PATCH + 1))"

echo "Current version: $CURRENT_VERSION"
read -p "New version [$NEXT_VERSION]: " INPUT_VERSION
VERSION="${INPUT_VERSION:-$NEXT_VERSION}"

echo ""
echo "Publishing opencode v$VERSION to dist.kamiwaza.ai"
echo ""

# Set AWS profile for Cloudflare R2
export AWS_PROFILE="kzprod"
echo "Using AWS profile: $AWS_PROFILE"

# Update version in opencode package.json only
echo ""
echo "=== Updating version ==="
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$OPENCODE_DIR/package.json"
echo "Updated: $OPENCODE_DIR/package.json"

# Build
echo ""
echo "=== Building opencode ==="
cd "$OPENCODE_DIR"
export OPENCODE_VERSION="$VERSION"
export OPENCODE_CHANNEL="latest"
bun run script/build.ts

# Smoke test
ARCH=$(uname -m)
case "$ARCH" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64) ARCH="x64" ;;
esac
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
BINARY_NAME="opencode-${OS}-${ARCH}"

echo ""
echo "Smoke test: $BINARY_NAME"
./dist/$BINARY_NAME/bin/opencode --version

# Package archives
echo ""
echo "=== Packaging archives ==="
cd dist
for dir in opencode-*/; do
    name="${dir%/}"
    if [[ "$name" == *linux* ]]; then
        tar -czf "${name}.tar.gz" -C "$name/bin" opencode
        echo "Created: ${name}.tar.gz"
    else
        (cd "$name/bin" && zip -r "../../${name}.zip" opencode*)
        echo "Created: ${name}.zip"
    fi
done

# Upload to S3
echo ""
echo "=== Uploading to S3 ==="
BUCKET="s3://opencode/opencode/releases"

for file in opencode-*.tar.gz opencode-*.zip; do
    [[ -f "$file" ]] || continue
    echo "Uploading: $file"
    aws s3 cp "$file" "$BUCKET/v$VERSION/$file" --acl public-read --profile "$AWS_PROFILE"
    aws s3 cp "$file" "$BUCKET/latest/$file" --acl public-read --profile "$AWS_PROFILE"
done

echo "$VERSION" > version.txt
aws s3 cp version.txt "$BUCKET/v$VERSION/version" --acl public-read --profile "$AWS_PROFILE"
aws s3 cp version.txt "$BUCKET/latest/version" --acl public-read --profile "$AWS_PROFILE"

echo ""
echo "=== Done ==="
echo ""
echo "Published opencode v$VERSION to:"
echo "  https://dist.kamiwaza.ai/opencode/releases/v$VERSION/"
echo "  https://dist.kamiwaza.ai/opencode/releases/latest/"
