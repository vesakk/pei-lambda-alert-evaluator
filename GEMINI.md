# GEMINI.md

## Project Overview

This project contains a serverless AWS Lambda function written in Node.js (ESM). The function, `pei-lambda-alert-evaluator`, is designed to be triggered by events from a DynamoDB stream connected to a `sensor_data` table.

Its primary purpose is to evaluate incoming sensor measurements against user-defined alert thresholds. These thresholds and user contact information are stored in a separate DynamoDB table (`alert_subscriptions`).

When a measurement crosses a defined threshold (taking hysteresis into account), the function triggers alerts via:
- **SMS** using Amazon SNS
- **Email** using Amazon SES

The function maintains the alert state for each sensor and user in an `alert_state` DynamoDB table. This allows it to manage alert cooldown periods, preventing notification spam, and to track when a sensor's state returns to normal.

**Key Technologies:**
- Node.js 20+ (ESM)
- AWS Lambda
- Amazon DynamoDB (for data, subscriptions, and state)
- Amazon SNS (for SMS alerts)
- Amazon SES (for email alerts)
- Vitest (for testing)
- AWS SDK for JavaScript v3

## Building and Running

### Building

There is no explicit build step required for this project, as it is written in JavaScript.

### Running Locally

The function is intended to be deployed and run on AWS Lambda. To run it locally, you would need to simulate a Lambda environment and provide it with a DynamoDB Stream event payload.

The tests provide a good example of how to invoke the handler function with simulated events.

### Testing

To run the unit tests, use the following command:

```bash
npm test
```

This command executes the test suite defined in `test/lambda_alert_evaluator.test.mjs` using `vitest`.

## Development Conventions

### Code Style

- The project uses modern JavaScript with ES Modules (`import`/`export`).
- The code is structured to be clean and readable, with helper functions separated from the main handler logic.

### Testing Practices

- Unit tests are located in the `test/` directory.
- The project uses `vitest` as its testing framework.
- AWS services are mocked using `aws-sdk-client-mock`, allowing for isolated and predictable testing of the function's logic without making actual AWS API calls.
- Tests cover various scenarios, including:
    - Triggering alerts on threshold breaches.
    - Respecting cooldown periods.
    - Handling the return to a normal state.
    - Ignoring irrelevant events or measurements.

### Configuration

- The function is configured via environment variables:
    - `SUBS_TABLE`: Name of the DynamoDB table for alert subscriptions (defaults to `alert_subscriptions`).
    - `STATE_TABLE`: Name of the DynamoDB table for alert state (defaults to `alert_state`).
    - `SES_FROM`: The email address to use as the sender for SES email alerts. This must be a verified identity in SES.
