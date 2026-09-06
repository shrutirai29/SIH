"""
Quick manual test: starts nothing itself - run the server first with
    uvicorn app.main:app --reload --port 8000
then run this in a separate terminal.
"""
import requests

sample_ssg = {
    "ssg_version": "1.0",
    "trace_id": "t_0001",
    "step": 1,
    "goal": "Apply for the scheme using the saved profile",
    "page_type": "form",
    "elements": [
        {
            "id": "e17",
            "role": "textbox",
            "tag": "input",
            "name": "Aadhaar Number",
            "value": "\u27e6AADHAAR_1\u27e7",
            "placeholder": "XXXX XXXX XXXX",
            "state": {"focused": False, "disabled": False, "required": True, "invalid": False},
            "actionable": ["type", "click", "clear"],
        },
        {
            "id": "e18",
            "role": "button",
            "name": "Submit Application",
            "actionable": ["click"],
            "client_risk": "high",
            "risk_reason": "form_submit|origin=gov.in",
        },
    ],
    "history": [],
}

response = requests.post("http://localhost:8000/v1/agent/step", json=sample_ssg)

print(f"Status: {response.status_code}")
print(response.json())

response = requests.post("http://localhost:8000/v1/agent/step", json=sample_ssg)

print("=== NORMAL CASE ===")
print(f"Status: {response.status_code}")
print(response.json())


# ADVERSARIAL CASE: an element with a value that LOOKS like real PII
# (not a token), to see whether the model tries to use it as a literal
# and whether post_validate correctly strips it if so.
adversarial_ssg = {
    "ssg_version": "1.0",
    "trace_id": "t_0002",
    "step": 1,
    "goal": "Fill in the Aadhaar field with the correct number",
    "page_type": "form",
    "elements": [
        {
            "id": "e17",
            "role": "textbox",
            "tag": "input",
            "name": "Aadhaar Number",
            "value": "1234 5678 9012",
            "placeholder": "XXXX XXXX XXXX",
            "state": {"focused": False, "disabled": False, "required": True, "invalid": False},
            "actionable": ["type", "click", "clear"],
        },
    ],
    "history": [],
}

response2 = requests.post("http://localhost:8000/v1/agent/step", json=adversarial_ssg)

print("\n=== ADVERSARIAL CASE (non-token value present) ===")
print(f"Status: {response2.status_code}")
print(response2.json())