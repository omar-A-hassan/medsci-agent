import os
import sys
import json
from unittest.mock import patch, MagicMock

# Explicitly add the python directory which is exactly one level up, in "python"
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "python")))

from paperqa_server import handle_analyze_papers, pre_seed_docs

def test_pre_seed_docs_bypasses_network_when_metadata_provided():
    mock_docs_instance = MagicMock()
    mock_docs_instance.docs = {}
    
    papers_data = [
        {"identifier": "10.1234/test", "title": "Mock Paper", "authors": ["Doe, J"], "citation_count": 42},
        {"identifier": "10.5678/nopreseed"}
    ]
    
    result = pre_seed_docs(mock_docs_instance, papers_data)
    
    assert "10.1234/test" in result.docs
    assert result.docs["10.1234/test"]["title"] == "Mock Paper"
    assert result.docs["10.1234/test"]["citation_count"] == 42
    assert "10.5678/nopreseed" not in result.docs

@patch("paperqa_server.setup_paperqa_environment")
@patch.dict('sys.modules', {})  # Setup safe dict wrapper
def test_handle_analyze_papers_executes_successfully(mock_setup):
    mock_settings = MagicMock()
    mock_setup.return_value = mock_settings
    
    # We must patch sys.modules manually because it's imported INSIDE the function dynamically
    mock_paperqa_module = MagicMock()
    mock_docs_instance = MagicMock()
    mock_paperqa_module.Docs.return_value = mock_docs_instance
    
    mock_answer = MagicMock()
    mock_answer.formatted_answer = "Mock formatted answer."
    mock_answer.references = ["Ref 1"]
    mock_answer.context = ["Context 1"]
    
    mock_docs_instance.query.return_value = mock_answer
    
    with patch.dict('sys.modules', {'paperqa': mock_paperqa_module}):
        payload = {
            "query": "What is the meaning of life?",
            "papers": [{"identifier": "10.mock/123", "title": "Life"}]
        }
        
        result = handle_analyze_papers(payload)
        
        mock_docs_instance.add.assert_called_with("10.mock/123", settings=mock_settings)
        mock_docs_instance.query.assert_called_with("What is the meaning of life?", settings=mock_settings)
        
        assert result["answer"] == "Mock formatted answer."
        assert "Ref 1" in result["references"]
