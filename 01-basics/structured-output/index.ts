import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// The shape we want back — defined once, used for both the tool schema and TS types
interface JobPosting {
  job_title: string;
  company: string;
  location: string;
  salary_range: { min: number; max: number; currency: string } | null;
  required_skills: string[];
  seniority_level: "junior" | "mid" | "senior" | "lead" | "unknown";
}

const RAW_JOB_POST = `
  We're hiring at Acme Corp! Looking for a Senior Full-Stack Engineer to join our
  London team. You'll work on our core product alongside a small, senior team.

  What we need: 5+ years with React and Node.js, experience with PostgreSQL,
  and ideally some TypeScript. Nice to have: Redis, Docker.

  Salary: £85,000 – £110,000 depending on experience. Remote-friendly but
  we'd love someone who can come into London 2 days a week.
`;

async function extractJobPosting(text: string): Promise<JobPosting> {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: `Extract structured information from this job posting:\n\n${text}`,
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "extract_job_posting",
          description: "Extract structured fields from a job posting",
          parameters: {
            type: "object",
            properties: {
              job_title: { type: "string" },
              company: { type: "string" },
              location: { type: "string" },
              salary_range: {
                type: ["object", "null"],
                properties: {
                  min: { type: "number" },
                  max: { type: "number" },
                  currency: { type: "string" },
                },
                required: ["min", "max", "currency"],
              },
              required_skills: {
                type: "array",
                items: { type: "string" },
              },
              seniority_level: {
                type: "string",
                enum: ["junior", "mid", "senior", "lead", "unknown"],
              },
            },
            required: [
              "job_title",
              "company",
              "location",
              "salary_range",
              "required_skills",
              "seniority_level",
            ],
          },
        },
      },
    ],
    // Force the model to call our tool rather than responding in free text
    tool_choice: { type: "function", function: { name: "extract_job_posting" } },
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall) throw new Error("Model did not return a tool call");

  return JSON.parse(toolCall.function.arguments) as JobPosting;
}

async function main() {
  console.log("Input:\n", RAW_JOB_POST.trim());
  console.log("\nExtracting...\n");

  const result = await extractJobPosting(RAW_JOB_POST);

  console.log("Extracted:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
