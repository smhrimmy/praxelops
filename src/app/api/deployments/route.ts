import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { DeploymentRunner } from "@/lib/deployments/runner";
import { TriggerDeploymentSchema, DeploymentWorkflow } from "@/types/deployment";

export async function GET() {
  try {
    const deployments = StorageService.getDeployments();
    if (deployments.length === 0) {
      // Seed a sample deployment for initial view
      const seedDeployment: DeploymentWorkflow = {
        id: "deploy-demo-01",
        name: "PraxelOps Production Release v1.0.0",
        serverId: "srv-local-01",
        serverName: "Localhost Hypervisor",
        appDirectory: "/var/www/praxelops",
        environment: "production",
        status: "healthy",
        steps: [
          {
            id: "step-1",
            name: "Pull Latest Git Artifacts",
            command: "git pull origin main",
            status: "success",
            exitCode: 0,
            outputLog: "From github.com:praxel/praxelops\n * branch main -> FETCH_HEAD\nAlready up to date.",
          },
          {
            id: "step-2",
            name: "Install Production Dependencies",
            command: "npm ci --production",
            status: "success",
            exitCode: 0,
            outputLog: "audited 174 packages in 1.4s\nfound 0 vulnerabilities",
          },
          {
            id: "step-3",
            name: "Build Next.js Bundle",
            command: "npm run build",
            status: "success",
            exitCode: 0,
            outputLog: "✓ Compiled successfully\n✓ Generating static pages (5/5)\n✓ Finalizing page optimization",
          },
          {
            id: "step-4",
            name: "Zero-Downtime Reload",
            command: "systemctl reload-or-restart praxelops",
            status: "success",
            exitCode: 0,
            outputLog: "Reloaded praxelops.service without connection drops.",
          },
        ],
        healthCheckUrl: "http://127.0.0.1:3000/api/health",
        healthCheckExpectedStatus: 200,
        rollbackCommand: "git reset --hard HEAD~1 && systemctl restart praxelops",
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        completedAt: new Date(Date.now() - 7140000).toISOString(),
      };
      StorageService.saveDeployment(seedDeployment);
      return NextResponse.json({ success: true, data: [seedDeployment] });
    }
    return NextResponse.json({ success: true, data: deployments });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (body.action === "rollback") {
      const workflow = StorageService.getDeployments().find(
        (d) => d.id === body.workflowId
      );
      if (!workflow) {
        return NextResponse.json(
          { success: false, error: "Workflow not found" },
          { status: 404 }
        );
      }
      const updated = await DeploymentRunner.rollback(workflow);
      return NextResponse.json({ success: true, data: updated });
    }

    const parsed = TriggerDeploymentSchema.parse(body);
    const server = StorageService.getServerById(parsed.serverId);
    if (!server) {
      return NextResponse.json(
        { success: false, error: "Target server not found" },
        { status: 404 }
      );
    }

    const newWorkflow: DeploymentWorkflow = {
      id: `deploy-${Date.now()}`,
      name: parsed.name,
      serverId: server.id,
      serverName: server.name,
      appDirectory: parsed.appDirectory,
      environment: parsed.environment,
      status: "queued",
      steps: parsed.steps.map((s, idx) => ({
        id: `step-${idx + 1}`,
        name: s.name,
        command: s.command,
        status: "pending",
      })),
      healthCheckUrl: parsed.healthCheckUrl,
      rollbackCommand: parsed.rollbackCommand,
      createdAt: new Date().toISOString(),
    };

    StorageService.saveDeployment(newWorkflow);

    // Run asynchronously
    DeploymentRunner.runWorkflow(newWorkflow).catch((err) =>
      console.error("Workflow failed:", err)
    );

    return NextResponse.json({ success: true, data: newWorkflow }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 400 }
    );
  }
}
