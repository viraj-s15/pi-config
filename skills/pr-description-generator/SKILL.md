---
name: pr-description-generator
description: Generates exhaustive, architecture-focused PR descriptions including Mermaid flow diagrams, infrastructure impacts, and logic summaries using the gh cli.
---

# PR Description Agent

## Objective
To transform a raw code diff into a comprehensive, high-context Pull Request description. This agent ensures that the "why" and "how" of a change are documented as thoroughly as the "what," prioritizing architectural intent and systemic impact over simple line-by-line summaries.

## Methodology & Workflow

### 1. Contextual Intelligence Gathering
* **Source Analysis:** Use the GitHub CLI (`gh pr diff` or `git diff`) to extract the full scope of changes.
* **Objective Extraction:** Read the PR title and any existing skeleton comments to identify the primary goal (e.g., migrating a service to Cloud Run, implementing a new FastAPI endpoint, or updating Terraform modules).
* **Dependency Mapping:** Identify changes to configuration files (e.g., `main.tf`, `dockerfile`, `requirements.txt`) to understand the infrastructure and environment requirements.

### 2. Comprehensive Analysis Focus
* **Architectural Intent:** Describe the high-level design pattern being introduced or modified. 
* **Business Logic Flow:** Trace the path of data through the new or modified functions.
* **Infrastructure & DevOps Impact:** Explicitly call out changes to GCP resources, Kubernetes manifests, or CI/CD pipelines.
* **Data Persistence & State:** Detail any changes to database schemas, BigQuery table structures, or Redis caching logic.

### 3. Documentation Components (The "Verbose" Standard)

The generated description must include the following sections:

#### A. Executive Summary
A 2-3 sentence high-level overview of the change. Focus on the value provided (e.g., "Standardizing the AI service migration path to improve deployment reliability").

#### B. Technical Deep-Dive
A detailed breakdown of the internal logic. Use bullet points to describe:
* Algorithm choices and complexity.
* Changes to internal APIs or interface definitions (e.g., Pydantic models in FastAPI).
* Error handling strategies and edge cases addressed.

#### C. Visual Architecture (Flow Diagrams)
Construct **Mermaid.js** diagrams to represent the logic visually. 
* **Sequence Diagrams:** For multi-service interactions or complex API request/response cycles.
* **Flowcharts:** For conditional business logic or state machine transitions within backend services.
* **Infrastructure Graphs:** To visualize changes in Terraform-managed resources or GKE service topologies.

#### D. Infrastructure & Security Impact
* List all modified Terraform resources (e.g., new Cloud SQL instances, IAM role bindings).
* Highlight any changes to environment variables or secret management.
* Note any potential performance regressions or cost implications on GCP/GKE.

#### E. Testing & Validation
* Describe the unit and integration tests added.
* Include a "Manual Verification" checklist for the reviewer.
* Provide sample logs or output snippets if applicable.

### 4. Implementation via GitHub CLI
* **Drafting:** Use `gh pr edit --body "[Generated Markdown Content]"` to populate the PR description.
* **Formatting:** Ensure all code snippets use appropriate syntax highlighting (e.g., `bash`, `python`, `hcl`).
* **Non-Destructive Update:** If a description already exists, the agent should prepend the "Technical Context" section while preserving existing user notes unless instructed otherwise.

## Constraints & Standards
* **Human-Centric Language:** Avoid "Agent-speak." Write as a senior engineer providing context to a peer.
* **No Redundancy:** Do not simply list file names; describe the *change* within the file.
* **Diagram Integrity:** Ensure all Mermaid syntax is valid and will render correctly within the GitHub UI.
