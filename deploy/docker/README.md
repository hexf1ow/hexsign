# Optional: building your own images

You do **not** need these. The overlay in this repo works on the public upstream images
(`opensign/opensignserver:main`, `opensign/opensign:main`) — just run the stack, then `scripts/apply.sh`.

These Dockerfiles are kept for reference: they are how our deployment produced its own tags
(`hexflow/opensign-server:3.0`, `hexflow/opensign-client:12.0`) before the overlay existed. Building
them simply renames the vendor strings inside the image; the overlay now does the same thing after
start-up, and more.

```bash
docker build -f deploy/docker/Dockerfile.server -t yourorg/sign-server:1 .
docker build -f deploy/docker/Dockerfile.client -t yourorg/sign-client:1 .
# then in deploy/opensign.env:
# OPENSIGN_SERVER_IMAGE=yourorg/sign-server:1
# OPENSIGN_CLIENT_IMAGE=yourorg/sign-client:1
```
