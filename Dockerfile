FROM ubuntu:22.04
LABEL maintainer="milton@lajollalabs.com"
RUN apt-get update
RUN apt install -y nodejs && apt install -y npm
RUN apt-get install -y vim
RUN apt install -y git
RUN mkdir /root/.ssh
ADD config/id_ed25519 /root/.ssh/id_ed25519
RUN apt-get install -y nginx


RUN echo "Adding the configuration file" 
COPY config/ssl.conf /etc/nginx/conf.d/
RUN echo "get checkout"
COPY config/hts.pem /etc/ssl/certs/hts.pem
COPY config/hts.rsa /etc/ssl/private/hts.rsa
RUN chmod 600 /root/.ssh/id_ed25519
RUN eval `ssh-agent -s` && ssh-add /root/.ssh/id_ed25519
RUN ssh-keyscan github.com >> $HOME/.ssh/known_hosts

RUN apt-get install wget 

RUN echo "Cloning ionworks server" 
RUN echo "Cloning ionworks server" 
RUN git clone git@github.com:lajollalabs/ionworks-server.git
RUN git clone git@github.com:lajollalabs/ionscript.git
RUN mv /ionscript /trailscript

RUN npm install -g n
RUN n lts
RUN n latest
RUN n prune 


RUN echo "Cloning ionworks server" 
RUN apt install -y curl
RUN curl https://raw.githubusercontent.com/creationix/nvm/master/install.sh | bash
ENV NVM_DIR /usr/local/nvm
RUN export NODE_OPTIONS="--max-old-space-size=5120"
RUN npm install forever -g
RUN cd /ionworks-server && npm i && npm run-script build 
RUN apt-get install python3
RUN echo "\n\n\n\tCloning ionworks\t\t" 
RUN echo "\n\n\n\tCloning ionworks\t\t" 
RUN git clone git@github.com:milton900807/IonWorks.git



RUN npm install -g @angular/cli && \
        export NODE_OPTIONS=--max_old_space_size=8048
RUN export NODE_OPTIONS="--max-old-space-size=5120" && cd /IonWorks && npm i --legacy-peer-deps && ng build --base-href / --configuration production

RUN echo "Copy the files into the ELN" 
RUN mkdir /eln && cp -r /IonWorks/dist/* /eln/
COPY config/env-hts.bio.js /eln/assets/env.js
RUN echo "----------------------------------------------------------- "
COPY config/run.sh /run.sh
RUN chmod +x /run.sh
ENTRYPOINT ["/run.sh"]

EXPOSE 80/tcp 443/tcp 1935/tcp 8080 5000/tcp 5000
