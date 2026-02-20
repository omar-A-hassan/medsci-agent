---
name: biopython
description: "Molecular biology toolkit. Use for FASTA parsing, sequence analysis, and translation."
---

# BioPython — Molecular Biology Toolkit

## When to Use
- Parsing FASTA sequence files
- Analyzing protein or nucleotide sequences
- Computing sequence composition and molecular weight
- Translating DNA to protein
- Working with sequence alignments

## Available Tools
- `parse_fasta(path)` — Read FASTA file, return sequence metadata
- `analyze_sequence(sequence, seq_type)` — Composition, MW, stats
- `analyze_sequence(sequence, seq_type="DNA", translate=true)` — Translate DNA→protein

## Amino Acid Properties
- **Hydrophobic**: A, V, L, I, M, F, W, P
- **Polar**: S, T, N, Q, Y, C
- **Positive**: K, R, H
- **Negative**: D, E
- **Special**: G (flexible), P (rigid)

## Common Sequence Analysis Tasks
1. Check sequence length and composition
2. Identify signal peptides (N-terminal Met + hydrophobic stretch)
3. Find potential glycosylation sites (N-X-S/T)
4. Calculate theoretical pI and MW
