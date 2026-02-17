#!/bin/bash

# Generate self-signed SSL certificates for development

set -e

CERT_DIR="./certs"
DAYS=365

echo "Generating self-signed SSL certificates..."

# Create certs directory
mkdir -p "$CERT_DIR"

# Generate private key and certificate
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days $DAYS \
  -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"

echo "Certificates generated in $CERT_DIR/"
echo "  - Certificate: $CERT_DIR/cert.pem"
echo "  - Private Key: $CERT_DIR/key.pem"
echo ""
echo "Update your .env file:"
echo "  SSL_CERT_PATH=$CERT_DIR/cert.pem"
echo "  SSL_KEY_PATH=$CERT_DIR/key.pem"
