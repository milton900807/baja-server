#!/bin/bash

docker run -it --rm --name=hts -v /home/ljl/dockers/ionworks-server/config:/config -p 8888:8888 -p 8080:8080 -p  443:443 hts

