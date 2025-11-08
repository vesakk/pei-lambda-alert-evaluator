# GEMINI.md

## Project Overview

This project is an AWS Lambda function named `pei-lambda-alert-evaluator`. It is written in Node.js (v20+) using ES Modules.

Its primary purpose is to process real-time sensor data from a DynamoDB Stream. When new data for a sensor is inserted, this function evaluates the data against user-defined alert subscriptions.

**Core Logic:**

1.  **Trigger:** The Lambda is triggered by `INSERT` events in a DynamoDB table stream (presumably containing sensor data).
2.  **Subscriptions:** It fetches alert subscriptions from an `alert_subscriptions` DynamoDB table. Each subscription defines thresholds for specific metrics for a sensor.
3.  **State Evaluation:** The function checks the incoming sensor metric values against the subscribed thresholds. It maintains the alert state (`high`, `low`, `ok`) in an `alert_state` DynamoDB table. Hysteresis is applied to prevent rapid state changes (flapping).
4.  **Notifications:** If a metric value crosses a threshold and enters an alarm state (`high` or `low`), the function sends notifications through multiple channels:
    *   **Email:** Using AWS SES (Simple Email Service).
    *   **SMS:** Using AWS SNS (Simple Notification Service).
5.  **Cooldown:** A cooldown mechanism is in place to prevent sending excessive notifications for an ongoing alert.

## Building and Running

### Dependencies

Install project dependencies using npm:

```bash
npm install
```

### Testing

The project uses `vitest` for testing. Tests are located in the `test/` directory and use `aws-sdk-client-mock` to mock AWS services.

Run the tests with:

```bash
npm test
```

## Development Conventions

*   **Language:** Modern Node.js (v20+) with ES Modules (`"type": "module"`).
*   **Source Code:** The main application logic is in `src/lambda_alert_evaluator.mjs`. The entry point for the Lambda is `index.mjs`.
*   **Testing:** Tests are written with `vitest`. Mocks for AWS services are created using `aws-sdk-client-mock`. Test files end with `.test.mjs`.
*   **Configuration:** The Lambda function is configured via environment variables:
    *   `SUBS_TABLE`: Name of the DynamoDB table for alert subscriptions.
    *   `STATE_TABLE`: Name of the DynamoDB table for alert states.
    *   `SES_FROM`: The verified email address to send alerts from using SES.

## Deployment

Deployment to AWS Lambda is automated via a GitHub Actions workflow defined in `.github/workflows/deploy.yml`.

The workflow is triggered on every push to the `main` branch. It performs the following steps:

1.  **Run Tests:** Executes `npm test` to ensure code quality.
2.  **Package:** Creates a `.zip` archive containing the necessary production code and dependencies (`npm prune --omit=dev`).
3.  **Authenticate:** Securely authenticates with AWS using OIDC.
4.  **Upload:** Uploads the deployment package to a designated S3 bucket.
5.  **Deploy:** Updates the Lambda function's code and configuration (including environment variables) with the new version from S3.
