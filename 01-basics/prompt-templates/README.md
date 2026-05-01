# Prompt Templates

A prompt template is just a string with variables filled in before you send it to the model.

---

## What this demonstrates

- Building a prompt with string interpolation
- Passing different variables into the same template
- Reusing one template for TypeScript and Python code review
- Keeping the template function in the same script

---

## Run it

```bash
cp .env.example .env
# add your OPENAI_API_KEY to .env

npm install
npm start
```

Expected output:

```text
Variables:
{ language: 'TypeScript', format: 'bullet points', focus: 'edge cases' }

Response:
- ...
------------------------------------------------------------
Variables:
{ language: 'Python', format: 'a numbered list', focus: 'performance' }
```

---

## The key insight

Prompt templates are not a framework feature. The template engine can be a function that takes an object and returns a string.

The subtle bug is forgetting that some variables may be user-controlled. If a user's code contains `Ignore all previous instructions`, that text is now inside your prompt. In production, sanitize or isolate untrusted variables before mixing them with your instructions.
