# GoldenIce Backend Scaffold

This directory holds the non-Supabase runtime pieces for GoldenIce.

## Purpose

- Receipt perceptual hashing and duplicate detection
- OCR fallback parsing for difficult receipts
- Rolling fraud analytics jobs
- Daily owner digest generation

Supabase remains the source of truth for auth, storage, database rows, and access control. This service is intentionally narrow and should consume typed events from Supabase rather than owning loyalty state directly.

## Suggested runtime

- Node.js + TypeScript
- HTTP API for sync receipt verification fallback
- Scheduled workers for nightly concentration checks and digest generation

## Initial contract

- `POST /receipt/verify`
- `POST /fraud/evaluate`
- `POST /digest/nightly`

Each endpoint should accept transaction context plus venue settings and return pure evaluation results. Any durable write should happen via Supabase RPCs or service-role operations after evaluation succeeds.
