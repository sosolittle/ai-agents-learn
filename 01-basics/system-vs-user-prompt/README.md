# System vs User Prompt

The same user question can produce very different answers depending on the system message that comes before it.

---

## What this demonstrates

- Sending a request with no system prompt
- Sending the same user question with two different system prompts
- Building the `messages` array with `system` and `user` roles
- Printing the prompt setup next to the response

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
System prompt:
(none)

Response:
An API rate limit is...
------------------------------------------------------------
System prompt:
You are a pirate. Respond only in pirate speak.

Response:
Arrr...
```

---

## The key insight

The system prompt is not special magic. It is a message with role `"system"` that the model treats as a persistent instruction.

It does not have absolute authority over the user message. The model weights system instructions differently by convention, but a sufficiently strong or conflicting user prompt can still override them. Production apps should not treat system prompts as a security boundary.
