import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { DeploymentRunner } from "@/lib/deployments/runner";
import { TriggerDeploymentSchema, DeploymentWorkflow } from "@/types/deployment";

export async function GET() {
  try {
    const deployments = StorageService.getDeployments();
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

    // Run workflow asynchronously
    DeploymentRunner.runWorkflow(newWorkflow).catch((err) =>
      console.error("Workflow run error:", err)
    );

    return NextResponse.json({ success: true, data: newWorkflow }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 400 }
    );
  }
}
