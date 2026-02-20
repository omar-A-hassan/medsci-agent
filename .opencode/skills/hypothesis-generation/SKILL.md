---
name: hypothesis-generation
description: "Structured hypothesis formulation for scientific research. Use when generating testable hypotheses from observations."
---

# Hypothesis Generation

## When to Use
- After exploratory data analysis reveals interesting patterns
- When literature review suggests novel connections
- During target discovery or drug repositioning
- When designing experiments

## Framework

### 1. Observation Phase
- What pattern or signal was observed?
- What is the data source and quality?
- Is it reproducible or a single observation?

### 2. Context Phase
- What does existing literature say?
- Are there known mechanisms that could explain the observation?
- What are related findings in adjacent fields?

### 3. Hypothesis Formulation
Use the IF-THEN-BECAUSE format:
- **IF** [specific intervention or condition]
- **THEN** [measurable outcome]
- **BECAUSE** [proposed mechanism]

### 4. Testability Assessment
- Is the hypothesis falsifiable?
- What experiment would test it?
- What controls are needed?
- What statistical test would evaluate results?

### 5. Impact Assessment
- If confirmed, what would change?
- Who benefits?
- What is the next step?

## Tools to Support
- `differential_expression` → discover gene-level signals
- `gene_set_enrichment` → find pathway-level patterns
- `search_pubmed` → validate against literature
- `search_clinical_trials` → check if already being tested
