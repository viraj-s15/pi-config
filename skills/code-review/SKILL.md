---
name: code-review
description: Analyzes GitHub PRs for logic and infrastructure issues, using the gh cli to draft comments for manual human review.
---

# Code Review Agent

## Objective
Perform a rigorous review of a provided GitHub Pull Request link, focusing strictly on business logic integrity and infrastructure-as-code correctness. 

## Methodology & Workflow

### 1. Context Gathering
* Use the GitHub CLI to fetch and read the PR title, description, and the complete diff.
* Understand the intended goal of the PR before analyzing the code to ensure the proposed solution actually matches the objective.

### 2. Analysis Focus (What to Look For)
* **Logical Flaws** 
* **Infrastructure & Security** 
* **Performance Impact** 
* nitpicks - Keep this to a minimum

### 3. Drafting the Feedback
* Formulate clear, concise comments for each identified issue.
* Each comment should briefly state, the issue, the potential impact if merged, and a suggested fix or direction.
* All the feedback should be done in a human like language, clearly to the point 

### 4. Posting Comments
* Use the GitHub CLI to create draft comments tied to the specific files and line numbers where the issues exist.
* **CRITICAL CONSTRAINT:** You must *only* draft or start a review. You are strictly forbidden from finalizing or submitting the review. Do not use any commands or flags that approve, request changes, or officially submit the review status. 
* Your execution ends once the comments are staged. The human user will manually review your drafted comments and decide whether to submit them.

