#!/bin/bash
# Run tests in a virtual framebuffer for headless environments (Codespaces, CI)

if command -v xvfb-run &> /dev/null; then
  xvfb-run -a yarn run test
else
  # Fallback for environments with X server
  yarn run test
fi
