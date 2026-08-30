import json, sys, rfc8785
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
operation = sys.argv[1]
data = sys.stdin.buffer.read()
if operation == 'canonical':
    sys.stdout.buffer.write(rfc8785.dumps(json.loads(data)))
elif operation == 'sign':
    sys.stdout.write(Ed25519PrivateKey.from_private_bytes(bytes.fromhex(sys.argv[2])).sign(data).hex())
else:
    raise ValueError('unknown operation')
