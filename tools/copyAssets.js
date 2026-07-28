const shell = require ('shelljs')

// Copy all the view templates
shell.cp("-R", "src/views", "dist/");
shell.cp("-R", "py-scripts", "dist/");
shell.cp("-R", "config", "dist/");
