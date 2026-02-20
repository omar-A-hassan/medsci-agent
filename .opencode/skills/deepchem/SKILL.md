---
name: deepchem
description: Molecular ML with DeepChem - featurizers, models, and molecular property prediction
---

# DeepChem

## Overview
DeepChem is a Python library for molecular machine learning. It provides featurizers, datasets, model wrappers, and splitters for drug discovery and materials science tasks.

## Featurizers
- **ECFP** (Extended Connectivity Fingerprints): `dc.feat.CircularFingerprint(size=1024, radius=2)`
- **GraphConv**: `dc.feat.ConvMolFeaturizer()` -- converts molecules to graph objects.
- **Weave**: `dc.feat.WeaveFeaturizer()` -- atom and pair features.
- **RDKitDescriptors**: `dc.feat.RDKitDescriptors()` -- 200+ physicochemical descriptors.

## Typical Workflow
```python
import deepchem as dc

# Load or create dataset from SMILES
featurizer = dc.feat.CircularFingerprint(size=1024, radius=2)
loader = dc.data.CSVLoader(tasks=["activity"], feature_field="smiles", featurizer=featurizer)
dataset = loader.create_dataset("data.csv")

# Split
splitter = dc.splits.ScaffoldSplitter()
train, valid, test = splitter.train_valid_test_split(dataset)

# Train model
model = dc.models.MultitaskClassifier(n_tasks=1, n_features=1024, layer_sizes=[512, 256])
model.fit(train, nb_epoch=50)

# Evaluate
metric = dc.metrics.Metric(dc.metrics.roc_auc_score)
print(model.evaluate(test, [metric]))
```

## Graph Convolutional Models
```python
featurizer = dc.feat.ConvMolFeaturizer()
model = dc.models.GraphConvModel(n_tasks=1, mode="classification")
```

## Key Details
- Splitters: `RandomSplitter`, `ScaffoldSplitter` (preferred for generalization), `ButinaSplitter`.
- MoleculeNet benchmarks available via `dc.molnet.load_*()` (e.g., `load_tox21()`, `load_bbbp()`).
- Install: `pip install deepchem`.
