# Hotel Reservation Lab

This clean-room system-design practice starts with one question: how can a multi-night inventory hold become one durable booking
without overselling any night, while keeping search visibility, price quotation, payment, room assignment, and check-in as
different receipts?

The prompt title is “Hotel Reservation System.” This repository does not copy a travel product, source chapter, protocol,
diagram, property catalogue, rate, guest record, benchmark, or proprietary behavior. The initial contract is frozen from the title
alone before reading the fixed secondary chapter.

## Current phase

Closed-book contract only. Source comparison, primary references, inventory/storage choice, implementation, tests, benchmark,
public remote, CI, deployment, payment/property integration, SLA, and external acceptance are all pending.

Candidate concerns include local-date stay intervals, per-night inventory conservation, quote and catalogue revisions, atomic
multi-night holds, expiry ownership, booking idempotency, worker fencing, cancellation, stable reads, and evidence separation.
They remain hypotheses until source review and executable validation.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Security policy](SECURITY.md)

## Evidence boundary

Search result, quote, active hold, inventory debit, booking confirmation, payment authorization/capture, room assignment, property
acknowledgement, check-in, completed stay, refund, and business acceptance are different facts. This lab will name and test only
the boundaries it reaches. It will abstain from real availability, price accuracy, payment, revenue, occupancy, guest arrival,
room access, SLA, or external acceptance without matching evidence.

## License

MIT. Third-party study material and real hospitality, guest, rate, or payment data are not included.
