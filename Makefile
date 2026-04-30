DOCKER=docker compose -f 

dev:
	$(DOCKER) docker-compose-dev.yml up -d --force-recreate --build

prod:
	$(DOCKER) docker-compose.yml up -d --force-recreate

down:
	docker compose down
