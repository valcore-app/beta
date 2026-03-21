import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";

describe("Tabs", () => {
  it("switches visible content when trigger is clicked", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Tab A</TabsTrigger>
          <TabsTrigger value="b">Tab B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Content A</TabsContent>
        <TabsContent value="b">Content B</TabsContent>
      </Tabs>,
    );

    expect(screen.getByText("Content A")).toBeInTheDocument();
    expect(screen.queryByText("Content B")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tab B" }));

    expect(screen.getByText("Content B")).toBeInTheDocument();
    expect(screen.queryByText("Content A")).not.toBeInTheDocument();
  });
});