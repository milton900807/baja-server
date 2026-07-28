import * as shell from "shelljs";

// Copy all the view templates
shell.cp("-R", "src/views", "dist/");
shell.cp("-R", "py-scripts", "dist/");
shell.cp("-R", "config", "dist/");
shell.cp("-R", "reference_data", "dist/");
shell.cp("-R", "nmd", "dist/");